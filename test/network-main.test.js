const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const networkSource = fs.readFileSync(path.join(__dirname, "..", "src", "network-main.js"), "utf8")

class EventTargetMock {
  constructor() {
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event)
    return true
  }
}

class CustomEventMock {
  constructor(type, init = {}) {
    this.type = type
    this.detail = init.detail
  }
}

class XMLHttpRequestMock extends EventTargetMock {
  open() {}
  setRequestHeader() {}
  send() {}
}

function tweetPage(id, cursor) {
  const entries = [
    {
      entryId: `tweet-${id}`,
      content: { itemContent: { tweet_results: { result: { rest_id: id } } } },
    },
  ]
  if (cursor) entries.push({ entryId: `cursor-bottom-${cursor}`, content: { value: cursor } })
  return {
    data: {
      user: {
        result: {
          timeline_v2: { timeline: { instructions: [{ entries }] } },
        },
      },
    },
  }
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return { json: async () => data }
    },
    json: async () => data,
  }
}

test("captures a timeline request and paginates it with the next cursor", async () => {
  const page = new EventTargetMock()
  const calls = []
  const events = []
  const firstUrl = "https://x.com/i/api/graphql/query123/UserTweets?variables=%7B%22userId%22%3A%221%22%2C%22count%22%3A20%7D&features=%7B%7D"
  const secondPage = tweetPage("2", null)
  const context = {
    location: { href: "https://x.com/Example" },
    URL,
    Headers,
    Request,
    CustomEvent: CustomEventMock,
    XMLHttpRequest: XMLHttpRequestMock,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      calls.push(url)
      if (calls.length === 1) return response(tweetPage("1", "cursor-1"))
      return response(secondPage)
    },
    addEventListener: page.addEventListener.bind(page),
    dispatchEvent: (event) => {
      events.push(JSON.parse(event.detail))
      return page.dispatchEvent(event)
    },
  }
  context.globalThis = context
  vm.runInNewContext(networkSource, context)

  await context.fetch(firstUrl, {
    headers: {
      Authorization: "Bearer web",
      "X-Csrf-Token": "csrf",
    },
  })
  await new Promise((resolve) => setImmediate(resolve))

  page.dispatchEvent(
    new CustomEventMock("xscope-network-command-v1", {
      detail: JSON.stringify({
        source: "xscope-content",
        kind: "start-scan",
        requestId: "scan-1",
        operation: "UserTweets",
        maxPages: 2,
        count: 100,
        pageDelayMs: 0,
      }),
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 25))

  const pageEvents = events.filter((event) => event.kind === "graphql-page")
  assert.equal(pageEvents.length, 2)
  assert.deepEqual(pageEvents.map((event) => event.data.data.user.result.timeline_v2.timeline.instructions[0].entries[0].entryId), [
    "tweet-1",
    "tweet-2",
  ])
  assert.equal(events.some((event) => event.kind === "graphql-complete" && event.pages === 2), true)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /cursor-1/)
})
