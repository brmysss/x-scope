(() => {
  const core = globalThis.XScopeCore
  if (!core || document.querySelector("#xscope-root")) return

  const SCAN_DELAY = 700
  const MAX_ROUNDS = 180
  const MAX_TWEETS = 5_000
  const GRAPHQL_MAX_PAGES = 40
  const GRAPHQL_PAGE_SIZE = 100
  const GRAPHQL_PAGE_DELAY = 1_500
  const GRAPHQL_START_TIMEOUT = 6_000
  const IDLE_ROUNDS_TO_STOP = 12
  const STORAGE_PREFIX = "xscope-profile-"
  const NETWORK_EVENT_NAME = "xscope-network-event-v1"
  const NETWORK_COMMAND_NAME = "xscope-network-command-v1"

  const state = {
    contextKey: null,
    handle: null,
    mode: "profile",
    searchQuery: "",
    searchInput: "",
    profileData: { tweets: [], scannedAt: null, coverage: null },
    sortKey: "likes",
    originalOnly: true,
    isScanning: false,
    stopRequested: false,
    scan: null,
    scanTimeout: null,
    route: location.href,
  }

  const root = document.createElement("div")
  root.id = "xscope-root"
  const shadow = root.attachShadow({ mode: "open" })
  shadow.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL("src/styles.css")}" />
    <button class="launcher" data-action="open" aria-label="打开 XScope">X</button>
    <section class="panel is-hidden" aria-label="XScope 用户热度">
      <header class="panel-header">
        <div>
          <div class="eyebrow">XSCOPE / LOCAL TOOLBOX</div>
          <h1>用户热度</h1>
          <div class="handle" data-role="handle">等待用户主页…</div>
        </div>
        <button class="icon-button" data-action="hide" aria-label="收起侧栏">×</button>
      </header>

      <div class="privacy-note">只在当前 X 页面使用公开响应；搜索结果和缓存均保存在本地。</div>

      <div class="search-box">
        <label class="search-label" for="xscope-search">搜索当前用户</label>
        <div class="search-row">
          <input id="xscope-search" data-role="search-input" type="search" maxlength="240" placeholder="例如：115 或 直充" />
          <button class="search-button" data-action="local-search">本地</button>
          <button class="search-button search-button-primary" data-action="x-search">X 搜索</button>
        </div>
        <div class="search-hint">X 搜索会自动加上 from:当前用户名，并切换到最新结果。</div>
      </div>

      <div class="actions">
        <button class="primary-button" data-action="scan">获取历史数据</button>
        <button class="secondary-button" data-action="dom-scan">滚动兜底</button>
        <button class="secondary-button is-hidden" data-action="stop">停止</button>
      </div>

      <div class="status" data-role="status">打开 X 用户主页后获取历史数据。</div>

      <div class="stats">
        <div><strong data-role="total">0</strong><span>已收集</span></div>
        <div><strong data-role="oldest">—</strong><span>最早日期</span></div>
        <div><strong data-role="updated">—</strong><span>上次更新</span></div>
      </div>

      <div class="filters">
        <button class="filter is-active" data-sort="likes">最多点赞</button>
        <button class="filter" data-sort="replies">最多回复</button>
        <button class="filter" data-sort="reposts">最多转发</button>
        <button class="filter" data-sort="views">最多浏览</button>
      </div>

      <label class="checkbox-row">
        <input type="checkbox" data-action="original-only" checked />
        <span>只看原创推文</span>
      </label>

      <div class="coverage" data-role="coverage">尚未扫描；这里不会承诺覆盖全部历史。</div>
      <ol class="tweet-list" data-role="list"></ol>
      <footer>v0.2.0 · GraphQL 分页 + X 搜索补漏 · XScope</footer>
    </section>
  `
  document.documentElement.appendChild(root)

  const elements = {
    launcher: shadow.querySelector('[data-action="open"]'),
    panel: shadow.querySelector(".panel"),
    handle: shadow.querySelector('[data-role="handle"]'),
    searchInput: shadow.querySelector('[data-role="search-input"]'),
    status: shadow.querySelector('[data-role="status"]'),
    total: shadow.querySelector('[data-role="total"]'),
    oldest: shadow.querySelector('[data-role="oldest"]'),
    updated: shadow.querySelector('[data-role="updated"]'),
    coverage: shadow.querySelector('[data-role="coverage"]'),
    list: shadow.querySelector('[data-role="list"]'),
    scan: shadow.querySelector('[data-action="scan"]'),
    domScan: shadow.querySelector('[data-action="dom-scan"]'),
    stop: shadow.querySelector('[data-action="stop"]'),
    originalOnly: shadow.querySelector('[data-action="original-only"]'),
    filters: [...shadow.querySelectorAll("[data-sort]")],
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;")
  }

  function storageKey(handle) {
    return `${STORAGE_PREFIX}${handle.toLowerCase()}`
  }

  function emptyProfile(handle) {
    return { handle, tweets: [], scannedAt: null, coverage: null }
  }

  async function loadProfile(handle) {
    const key = storageKey(handle)
    const result = await chrome.storage.local.get(key)
    const saved = result[key]
    if (!saved || typeof saved !== "object") return emptyProfile(handle)
    return {
      ...emptyProfile(handle),
      ...saved,
      handle,
      tweets: Array.isArray(saved.tweets) ? saved.tweets : [],
    }
  }

  async function saveProfile(handle, profileData) {
    await chrome.storage.local.set({
      [storageKey(handle)]: {
        handle,
        tweets: core.mergeTweets([], profileData.tweets || []).slice(0, MAX_TWEETS),
        scannedAt: profileData.scannedAt || null,
        coverage: profileData.coverage || null,
      },
    })
  }

  function formatDate(value) {
    if (!value) return "未知日期"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "未知日期"
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date)
  }

  function formatScanTime(value) {
    if (!value) return "—"
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return "—"
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date)
  }

  function setStatus(message) {
    elements.status.textContent = message
  }

  function errorMessage(error) {
    if (error instanceof Error && error.message) return error.message
    return "未知错误"
  }

  function resetScanControls() {
    if (state.scanTimeout) window.clearTimeout(state.scanTimeout)
    state.scanTimeout = null
    state.isScanning = false
    state.stopRequested = false
    state.scan = null
    elements.scan.classList.remove("is-hidden")
    elements.domScan.classList.remove("is-hidden")
    elements.stop.classList.add("is-hidden")
  }

  function getPageContext() {
    const profile = core.parseProfileFromPath(location.pathname)
    if (profile) {
      return {
        ...profile,
        mode: "profile",
        key: `profile:${profile.handle.toLowerCase()}`,
      }
    }

    const search = core.parseSearchContext(location.pathname, location.search)
    if (search) {
      return {
        ...search,
        mode: "search",
        key: `search:${search.handle.toLowerCase()}:${search.query}`,
      }
    }

    return null
  }

  function sendNetworkCommand(payload) {
    try {
      window.dispatchEvent(
        new CustomEvent(NETWORK_COMMAND_NAME, {
          detail: JSON.stringify({ source: "xscope-content", ...payload }),
        }),
      )
      return true
    } catch {
      return false
    }
  }

  function requestNetworkState(operation) {
    sendNetworkCommand({
      kind: "get-state",
      requestId: `state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      operation,
    })
  }

  function updateContext() {
    const context = getPageContext()
    if (!context) {
      root.style.display = "none"
      return null
    }

    root.style.display = "block"
    if (context.key !== state.contextKey) {
      state.contextKey = context.key
      state.handle = context.handle
      state.mode = context.mode
      state.searchQuery = context.query || ""
      state.searchInput = context.mode === "search" ? core.extractSearchText(context.query) : ""
      state.profileData = emptyProfile(context.handle)
      togglePanel(true)

      void loadProfile(context.handle).then((data) => {
        if (state.contextKey !== context.key) return
        state.profileData = {
          ...data,
          tweets: core.mergeTweets(data.tweets, state.profileData.tweets).slice(0, MAX_TWEETS),
          coverage: state.profileData.coverage || data.coverage || null,
        }
        render()
        setStatus(
          data.tweets.length
            ? "已载入本地缓存，可继续获取历史或搜索补漏。"
            : context.mode === "search"
              ? "等待 X 搜索结果，或点击抓取搜索结果。"
              : "尚未获取这个用户的历史数据。",
        )
      }).catch((error) => {
        if (state.contextKey !== context.key) return
        render()
        setStatus(`本地缓存读取失败：${errorMessage(error)}。仍可尝试获取数据。`)
      })

      requestNetworkState(context.mode === "search" ? "SearchTimeline" : "UserTweets")
      window.setTimeout(() => {
        if (state.contextKey === context.key) {
          requestNetworkState(context.mode === "search" ? "SearchTimeline" : "UserTweets")
        }
      }, 800)
    }

    elements.handle.textContent = context.mode === "search" ? `@${context.handle} · X 搜索` : `@${context.handle}`
    elements.scan.textContent = context.mode === "search" ? "抓取搜索结果" : "获取历史数据"
    elements.domScan.textContent = context.mode === "search" ? "滚动搜索页" : "滚动兜底"
    return context
  }

  function captureVisibleTweets() {
    return [...document.querySelectorAll('article[data-testid="tweet"]')]
      .map((article) => core.parseTweetArticle(article, state.handle))
      .filter(Boolean)
  }

  function findOldestDate(tweets) {
    const dates = tweets
      .map((tweet) => new Date(tweet.createdAt || 0).getTime())
      .filter((time) => Number.isFinite(time) && time > 0)
    return dates.length ? new Date(Math.min(...dates)).toISOString() : null
  }

  function renderTweet(tweet, rank) {
    const text = tweet.text || "（这条推文没有可读取的文字，可能主要是媒体内容）"
    const metrics = [
      `♥ ${core.formatMetric(tweet.likes)}`,
      `↩ ${core.formatMetric(tweet.replies)}`,
      `↻ ${core.formatMetric(tweet.reposts)}`,
      `◉ ${core.formatMetric(tweet.views)}`,
    ].join(" · ")
    const tags = [tweet.isReply ? "回复" : "", tweet.isRetweet ? "转发" : "", tweet.hasMedia ? "媒体" : ""]
      .filter(Boolean)
      .join(" / ")

    return `
      <li class="tweet-item">
        <a href="${escapeHtml(tweet.url)}" target="_blank" rel="noopener noreferrer">
          <div class="tweet-topline"><span class="rank">#${rank}</span><span>${escapeHtml(formatDate(tweet.createdAt))}</span></div>
          <p>${escapeHtml(text)}</p>
          <div class="tweet-metrics">${escapeHtml(metrics)}</div>
          ${tags ? `<div class="tweet-tags">${escapeHtml(tags)}</div>` : ""}
        </a>
      </li>
    `
  }

  function coverageText(tweets, originalCount) {
    const coverage = state.profileData.coverage
    if (!tweets.length) {
      return state.mode === "search"
        ? "尚未获取搜索结果；可点击“X 搜索”打开搜索页。"
        : "尚未扫描；这里不会承诺覆盖全部历史。"
    }

    const oldest = formatDate(findOldestDate(tweets))
    if (coverage?.source === "graphql") {
      return `GraphQL 已获取 ${tweets.length} 条（原创 ${originalCount} 条），覆盖至 ${oldest}${coverage.complete ? "，分页已结束" : "，可能仍有遗漏"}。`
    }
    if (coverage?.source === "x-search") {
      return `X 搜索已补充 ${tweets.length} 条（原创 ${originalCount} 条），当前最早 ${oldest}；搜索结果不等于完整历史。`
    }
    if (coverage?.source === "dom") {
      return `滚动扫描已收集 ${tweets.length} 条（原创 ${originalCount} 条），覆盖至 ${oldest}。`
    }
    return `本地已有 ${tweets.length} 条（原创 ${originalCount} 条），最早 ${oldest}。`
  }

  function render() {
    const tweets = state.profileData.tweets || []
    const originalCount = tweets.filter((tweet) => !tweet.isReply && !tweet.isRetweet).length
    const query = state.searchInput.trim()
    const topTweets = query
      ? core.searchTweets(tweets, query, state.sortKey, 10, state.originalOnly)
      : core.getTopTweets(tweets, state.sortKey, 10, state.originalOnly)

    if (elements.searchInput.value !== state.searchInput) elements.searchInput.value = state.searchInput
    elements.total.textContent = String(tweets.length)
    elements.oldest.textContent = formatDate(findOldestDate(tweets))
    elements.updated.textContent = formatScanTime(state.profileData.scannedAt)
    elements.coverage.textContent = coverageText(tweets, originalCount)
    elements.list.innerHTML = topTweets.length
      ? topTweets.map((tweet, index) => renderTweet(tweet, index + 1)).join("")
      : `<li class="empty">${query ? `本地缓存中没有匹配“${escapeHtml(query)}”的推文。` : "暂无结果。请确认当前是用户主页或 X 搜索页。"}</li>`

    elements.filters.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sort === state.sortKey)
    })
  }

  function updateCoverage(source, complete, pages) {
    state.profileData.coverage = {
      source,
      complete,
      pages: pages || 0,
      query: state.mode === "search" ? state.searchQuery : null,
      oldest: findOldestDate(state.profileData.tweets),
    }
  }

  function mergeGraphqlData(operation, data, source, pages) {
    const parsed = core.parseGraphqlTimeline(data, state.handle)
    if (parsed.tweets.length) {
      state.profileData.tweets = core.mergeTweets(state.profileData.tweets, parsed.tweets).slice(0, MAX_TWEETS)
      updateCoverage(source, false, pages)
      render()
      void saveProfile(state.handle, state.profileData).catch(() => {})
    }
    return parsed
  }

  function beginGraphqlScan() {
    const context = updateContext()
    if (!context || state.isScanning) return

    const operation = context.mode === "search" ? "SearchTimeline" : "UserTweets"
    const requestId = `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
    state.isScanning = true
    state.stopRequested = false
    state.scan = { type: "graphql", requestId, operation, pages: 0 }
    elements.scan.classList.add("is-hidden")
    elements.domScan.classList.add("is-hidden")
    elements.stop.classList.remove("is-hidden")
    setStatus(context.mode === "search" ? "正在通过 X 搜索分页获取结果…" : "正在通过 X 内部时间线分页获取历史数据…")
    render()

    state.scanTimeout = window.setTimeout(() => {
      if (!state.scan || state.scan.requestId !== requestId || state.scan.pages > 0) return
      sendNetworkCommand({ kind: "stop-scan", requestId })
      void finishGraphqlScan(false, "没有捕获到 X 的内部请求，请刷新 X 页面后重试。")
    }, GRAPHQL_START_TIMEOUT)

    sendNetworkCommand({
      kind: "start-scan",
      requestId,
      operation,
      maxPages: GRAPHQL_MAX_PAGES,
      count: GRAPHQL_PAGE_SIZE,
      pageDelayMs: GRAPHQL_PAGE_DELAY,
    })
  }

  async function finishGraphqlScan(complete, message) {
    const scan = state.scan
    if (!scan || scan.type !== "graphql") return

    const handle = state.handle
    const pages = scan.pages
    state.profileData.scannedAt = new Date().toISOString()
    updateCoverage(state.mode === "search" ? "x-search" : "graphql", complete, pages)
    resetScanControls()
    render()

    let saveError = null
    try {
      await saveProfile(handle, state.profileData)
    } catch (error) {
      saveError = error
    }

    if (saveError) {
      setStatus(`已获取 ${state.profileData.tweets.length} 条，但本地保存失败：${errorMessage(saveError)}。`)
    } else if (message) {
      setStatus(message)
    } else {
      setStatus(`分页完成：本地共保存 ${state.profileData.tweets.length} 条。`)
    }
  }

  async function scanWithDom() {
    const context = updateContext()
    if (!context || state.isScanning) return

    state.isScanning = true
    state.stopRequested = false
    state.scan = { type: "dom" }
    elements.scan.classList.add("is-hidden")
    elements.domScan.classList.add("is-hidden")
    elements.stop.classList.remove("is-hidden")
    setStatus("准备扫描页面中已加载的推文…")

    const originalScrollY = window.scrollY
    let idleRounds = 0
    let previousCount = state.profileData.tweets.length
    let finishMessage = "页面暂时没有加载更多内容，滚动扫描结束。"

    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (state.stopRequested || state.handle !== context.handle) {
          finishMessage = "已停止滚动扫描，已收集内容仍会保存。"
          break
        }

        const visibleTweets = captureVisibleTweets()
        state.profileData.tweets = core.mergeTweets(state.profileData.tweets, visibleTweets).slice(0, MAX_TWEETS)
        const currentCount = state.profileData.tweets.length
        const newCount = currentCount - previousCount
        previousCount = currentCount
        idleRounds = newCount > 0 ? 0 : idleRounds + 1
        render()

        if (currentCount >= MAX_TWEETS) {
          finishMessage = `已达到 ${MAX_TWEETS} 条本地上限。`
          break
        }
        if (idleRounds >= IDLE_ROUNDS_TO_STOP) break

        setStatus(`滚动扫描中：已收集 ${currentCount} 条，继续向下加载…`)
        window.scrollBy(0, Math.max(window.innerHeight * 0.82, 560))
        await sleep(SCAN_DELAY)
      }
    } finally {
      state.profileData.scannedAt = new Date().toISOString()
      updateCoverage("dom", false, 0)
      window.scrollTo(0, originalScrollY)
      resetScanControls()
      render()
      try {
        await saveProfile(context.handle, state.profileData)
        setStatus(`滚动扫描完成：本地共保存 ${state.profileData.tweets.length} 条。${finishMessage}`)
      } catch (error) {
        setStatus(`扫描完成，但本地缓存保存失败：${errorMessage(error)}。`)
      }
    }
  }

  function openXSearch() {
    if (!state.handle) return
    const query = core.buildXSearchQuery(state.handle, elements.searchInput.value)
    const url = core.buildXSearchUrl(state.handle, elements.searchInput.value)
    state.searchInput = core.extractSearchText(query)
    render()

    const opened = window.open(url, "_blank", "noopener,noreferrer")
    if (opened) {
      setStatus(`已打开 X 搜索：${query}。在新标签页点击“抓取搜索结果”即可分页。`)
    } else {
      setStatus("浏览器阻止了新标签页，请允许弹窗后再点击 X 搜索。")
    }
  }

  function handleNetworkMessage(event) {
    let message
    try {
      message = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail
    } catch {
      return
    }
    if (!message || message.source !== "xscope-main") return
    if (!state.contextKey) return

    const expectedOperation = state.mode === "search" ? "SearchTimeline" : "UserTweets"
    const isExpectedOperation = message.operation === expectedOperation
    if (!isExpectedOperation) return

    if (message.kind === "graphql-response" || message.kind === "graphql-state") {
      const data = message.kind === "graphql-state" ? message.state?.data : message.data
      if (!data) return
      const parsed = mergeGraphqlData(message.operation, data, state.mode === "search" ? "x-search" : "graphql", 0)
      if (parsed.tweets.length && !state.isScanning) {
        setStatus(`已捕获 X 页面数据：本地共 ${state.profileData.tweets.length} 条，可继续分页。`)
      }
      return
    }

    if (!state.scan || state.scan.type !== "graphql" || message.requestId !== state.scan.requestId) return

    if (message.kind === "graphql-start") {
      if (state.scanTimeout) window.clearTimeout(state.scanTimeout)
      state.scanTimeout = null
      setStatus("已连接 X 内部时间线，开始分页…")
      return
    }

    if (message.kind === "graphql-page") {
      state.scan.pages = message.page || state.scan.pages + 1
      const parsed = mergeGraphqlData(message.operation, message.data, state.mode === "search" ? "x-search" : "graphql", state.scan.pages)
      setStatus(`分页扫描中：第 ${state.scan.pages} 页，本地共 ${state.profileData.tweets.length} 条…`)
      if (!parsed.tweets.length && !parsed.nextCursor) {
        setStatus("这一页没有新的推文，等待分页结束…")
      }
      return
    }

    if (message.kind === "graphql-complete") {
      void finishGraphqlScan(!message.stopped, message.stopped ? "已停止分页，已获取内容仍会保存。" : null)
      return
    }

    if (message.kind === "graphql-error") {
      void finishGraphqlScan(false, `GraphQL 获取未完成：${message.message || "未知错误"}`)
    }
  }

  function handleScanError(error) {
    resetScanControls()
    render()
    setStatus(`扫描失败：${errorMessage(error)}。请重试或使用滚动兜底。`)
  }

  function togglePanel(forceOpen) {
    const shouldOpen = forceOpen === undefined ? elements.panel.classList.contains("is-hidden") : forceOpen
    elements.panel.classList.toggle("is-hidden", !shouldOpen)
    elements.launcher.classList.toggle("is-hidden", shouldOpen)
  }

  window.addEventListener(NETWORK_EVENT_NAME, handleNetworkMessage)

  shadow.addEventListener("click", (event) => {
    const target = event.target.closest("button")
    if (!target) return

    if (target.dataset.action === "open") togglePanel(true)
    if (target.dataset.action === "hide") togglePanel(false)
    if (target.dataset.action === "scan") beginGraphqlScan()
    if (target.dataset.action === "dom-scan") void scanWithDom().catch(handleScanError)
    if (target.dataset.action === "stop") {
      if (state.scan?.type === "graphql") {
        sendNetworkCommand({ kind: "stop-scan", requestId: state.scan.requestId })
      } else {
        state.stopRequested = true
      }
    }
    if (target.dataset.action === "local-search") {
      state.searchInput = elements.searchInput.value.trim()
      render()
      setStatus(state.searchInput ? `正在本地搜索“${state.searchInput}”。` : "已显示当前本地缓存中的热门推文。")
    }
    if (target.dataset.action === "x-search") openXSearch()
    if (target.dataset.sort) {
      state.sortKey = target.dataset.sort
      render()
    }
  })

  elements.searchInput.addEventListener("input", () => {
    state.searchInput = elements.searchInput.value
  })

  elements.searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    state.searchInput = elements.searchInput.value.trim()
    render()
    setStatus(state.searchInput ? `正在本地搜索“${state.searchInput}”。` : "已显示当前本地缓存中的热门推文。")
  })

  elements.originalOnly.addEventListener("change", () => {
    state.originalOnly = elements.originalOnly.checked
    render()
  })

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "toggle-panel") togglePanel()
  })

  updateContext()
  render()

  window.setInterval(() => {
    if (location.href === state.route) return
    state.route = location.href
    updateContext()
    render()
  }, 500)

  const observer = new MutationObserver(() => {
    if (state.handle && !state.isScanning) {
      const context = getPageContext()
      if (context && context.key === state.contextKey) {
        elements.handle.textContent = context.mode === "search" ? `@${context.handle} · X 搜索` : `@${context.handle}`
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
})()
