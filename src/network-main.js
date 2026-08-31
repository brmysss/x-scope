(() => {
  const INSTALL_FLAG = "__xscopeNetworkBridgeInstalled"
  const EVENT_NAME = "xscope-network-event-v1"
  const COMMAND_NAME = "xscope-network-command-v1"
  const ALLOWED_HEADERS = new Set([
    "authorization",
    "x-csrf-token",
    "x-twitter-auth-type",
    "x-twitter-active-user",
    "x-twitter-client-language",
    "x-client-transaction-id",
    "x-client-uuid",
  ])
  const TRACKED_OPERATIONS = new Set([
    "UserTweets",
    "UserTweetsAndReplies",
    "UserMedia",
    "SearchTimeline",
  ])
  const HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"])
  const states = new Map()
  const stoppedScans = new Set()

  if (globalThis[INSTALL_FLAG]) return
  globalThis[INSTALL_FLAG] = true

  function emit(payload) {
    try {
      globalThis.dispatchEvent(
        new CustomEvent(EVENT_NAME, {
          detail: JSON.stringify({ source: "xscope-main", ...payload }),
        }),
      )
    } catch {
      // The page may be navigating or have a restrictive document implementation.
    }
  }

  function readDetail(event) {
    try {
      if (typeof event.detail === "string") return JSON.parse(event.detail)
      return event.detail
    } catch {
      return null
    }
  }

  function getGraphqlTarget(value) {
    try {
      const url = new URL(value, globalThis.location.href)
      if (!HOSTS.has(url.hostname)) return null

      const parts = url.pathname.split("/")
      const graphqlIndex = parts.indexOf("graphql")
      const operation = graphqlIndex >= 0 ? parts[graphqlIndex + 2] : null
      if (!operation || !TRACKED_OPERATIONS.has(operation)) return null

      return { url: url.href, operation }
    } catch {
      return null
    }
  }

  function snapshotHeaders(input, init) {
    const headers = new Headers()

    try {
      if (input instanceof Request) input.headers.forEach((value, name) => headers.set(name, value))
    } catch {
      // A non-standard Request-like object can be ignored.
    }

    try {
      if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    } catch {
      // Invalid custom headers do not prevent the original request from running.
    }

    return Object.fromEntries(
      [...headers.entries()].filter(([name]) => ALLOWED_HEADERS.has(name.toLowerCase())),
    )
  }

  function rememberResponse(meta, status, data) {
    const state = {
      url: meta.url,
      operation: meta.operation,
      method: meta.method || "GET",
      headers: meta.headers || {},
      status,
      data,
    }
    states.set(meta.operation, state)
    emit({ kind: "graphql-response", operation: meta.operation, status, url: meta.url, data })
  }

  async function captureFetch(meta, response) {
    let data
    try {
      data = await response.clone().json()
    } catch {
      return
    }
    rememberResponse(meta, response.status, data)
  }

  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = function xscopeFetch(input, init) {
    const target = getGraphqlTarget(typeof input === "string" ? input : input?.url)
    const meta = target
      ? {
          ...target,
          method: init?.method || input?.method || "GET",
          headers: snapshotHeaders(input, init),
        }
      : null

    const responsePromise = nativeFetch(input, init)
    if (meta) void responsePromise.then((response) => captureFetch(meta, response)).catch(() => {})
    return responsePromise
  }

  const xhrMetadata = new WeakMap()
  const nativeOpen = XMLHttpRequest.prototype.open
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader
  const nativeSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function xscopeOpen(method, url, ...rest) {
    const target = getGraphqlTarget(url)
    if (target) {
      xhrMetadata.set(this, {
        ...target,
        method: String(method || "GET").toUpperCase(),
        headers: {},
      })
    } else {
      xhrMetadata.delete(this)
    }
    return nativeOpen.call(this, method, url, ...rest)
  }

  XMLHttpRequest.prototype.setRequestHeader = function xscopeSetRequestHeader(name, value) {
    const metadata = xhrMetadata.get(this)
    if (metadata && ALLOWED_HEADERS.has(String(name).toLowerCase())) {
      metadata.headers[String(name).toLowerCase()] = String(value)
    }
    return nativeSetRequestHeader.call(this, name, value)
  }

  XMLHttpRequest.prototype.send = function xscopeSend(...args) {
    const metadata = xhrMetadata.get(this)
    if (metadata) {
      this.addEventListener(
        "load",
        () => {
          let data
          try {
            data = this.responseType === "json" ? this.response : JSON.parse(this.responseText)
          } catch {
            return
          }
          rememberResponse(metadata, this.status, data)
        },
        { once: true },
      )
    }
    return nativeSend.apply(this, args)
  }

  function findBottomCursor(value, visited = new WeakSet()) {
    if (!value || typeof value !== "object" || visited.has(value)) return null
    visited.add(value)

    if (value.cursorType === "Bottom" && typeof value.value === "string") return value.value
    if (value.entryId?.startsWith("cursor-bottom-") && typeof value.content?.value === "string") {
      return value.content.value
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const cursor = findBottomCursor(value[index], visited)
        if (cursor) return cursor
      }
      return null
    }

    const children = Object.values(value)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const cursor = findBottomCursor(children[index], visited)
      if (cursor) return cursor
    }
    return null
  }

  function buildCursorUrl(templateUrl, cursor, count) {
    try {
      const url = new URL(templateUrl, globalThis.location.href)
      const rawVariables = url.searchParams.get("variables")
      if (!rawVariables) return null

      const variables = JSON.parse(rawVariables)
      variables.cursor = cursor
      if (Number.isInteger(count) && count > 0) variables.count = count
      url.searchParams.set("variables", JSON.stringify(variables))
      return url.href
    } catch {
      return null
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
  }

  async function runScan(command) {
    const requestId = String(command.requestId || "")
    const operation = String(command.operation || "")
    const template = states.get(operation)
    const maxPages = Number.isInteger(command.maxPages) ? command.maxPages : 40
    const count = Number.isInteger(command.count) ? command.count : 100
    const pageDelay = Number.isInteger(command.pageDelayMs) ? command.pageDelayMs : 1500

    if (!requestId || !TRACKED_OPERATIONS.has(operation)) return
    if (!template?.data) {
      emit({
        kind: "graphql-error",
        requestId,
        operation,
        message: "没有捕获到 X 的内部时间线请求，请刷新当前 X 页面后重试。",
      })
      return
    }
    if (String(template.method || "GET").toUpperCase() !== "GET") {
      emit({
        kind: "graphql-error",
        requestId,
        operation,
        message: "当前 X 时间线请求不是 GET，暂时无法安全地复用它。",
      })
      return
    }

    stoppedScans.delete(requestId)
    emit({ kind: "graphql-start", requestId, operation })

    let currentData = template.data
    let currentUrl = template.url
    let cursor = null
    let pages = 0

    while (pages < maxPages && !stoppedScans.has(requestId)) {
      pages += 1
      emit({
        kind: "graphql-page",
        requestId,
        operation,
        page: pages,
        url: currentUrl,
        data: currentData,
      })

      const nextCursor = findBottomCursor(currentData)
      if (!nextCursor || nextCursor === cursor) break
      cursor = nextCursor
      if (pages >= maxPages || stoppedScans.has(requestId)) break

      await delay(pageDelay)
      if (stoppedScans.has(requestId)) break

      const nextUrl = buildCursorUrl(currentUrl, cursor, count)
      if (!nextUrl) {
        emit({
          kind: "graphql-error",
          requestId,
          operation,
          message: "X 的分页参数格式发生变化，无法继续请求下一页。",
        })
        return
      }

      let response
      try {
        response = await nativeFetch(nextUrl, {
          method: "GET",
          headers: template.headers,
          credentials: "include",
        })
        currentData = await response.json()
      } catch {
        emit({
          kind: "graphql-error",
          requestId,
          operation,
          message: "请求 X 下一页失败，可能是网络或登录状态问题。",
        })
        return
      }

      currentUrl = nextUrl
      states.set(operation, {
        ...template,
        url: currentUrl,
        status: response.status,
        data: currentData,
      })

      if (!response.ok) {
        emit({
          kind: "graphql-error",
          requestId,
          operation,
          status: response.status,
          message: `X 返回 HTTP ${response.status}，已停止分页。`,
        })
        return
      }
    }

    emit({ kind: "graphql-complete", requestId, operation, pages, stopped: stoppedScans.has(requestId) })
    stoppedScans.delete(requestId)
  }

  globalThis.addEventListener(COMMAND_NAME, (event) => {
    const command = readDetail(event)
    if (!command || command.source !== "xscope-content") return

    if (command.kind === "get-state") {
      const state = states.get(command.operation)
      emit({
        kind: "graphql-state",
        requestId: command.requestId,
        operation: command.operation,
        state: state
          ? { url: state.url, method: state.method, status: state.status, data: state.data }
          : null,
      })
      return
    }

    if (command.kind === "start-scan") {
      void runScan(command)
      return
    }

    if (command.kind === "stop-scan" && command.requestId) {
      stoppedScans.add(String(command.requestId))
    }
  })
})()
