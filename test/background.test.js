const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8")

test("toolbar click injects the content script when the receiver is missing", async () => {
  let clickHandler
  let sendCount = 0
  const calls = []
  const context = {
    chrome: {
      action: {
        onClicked: {
          addListener(handler) {
            clickHandler = handler
          },
        },
      },
      tabs: {
        async sendMessage(tabId, message) {
          calls.push(["sendMessage", tabId, message])
          sendCount += 1
          if (sendCount === 1) throw new Error("receiver missing")
        },
      },
      scripting: {
        async insertCSS(details) {
          calls.push(["insertCSS", details])
        },
        async executeScript(details) {
          calls.push(["executeScript", details])
        },
      },
      console,
    },
  }

  vm.runInNewContext(backgroundSource, context)
  await clickHandler({ id: 42, url: "https://x.com/example" })

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["sendMessage", 42, { type: "toggle-panel" }],
    ["insertCSS", { target: { tabId: 42 }, files: ["src/styles.css"] }],
    ["executeScript", { target: { tabId: 42 }, files: ["src/core.js", "src/content-script.js"] }],
    ["sendMessage", 42, { type: "toggle-panel" }],
  ])
})

test("toolbar click ignores non-X pages", async () => {
  let clickHandler
  let called = false
  const context = {
    chrome: {
      action: { onClicked: { addListener: (handler) => { clickHandler = handler } } },
      tabs: { sendMessage: async () => { called = true } },
      scripting: { insertCSS: async () => {}, executeScript: async () => {} },
      console,
    },
  }

  vm.runInNewContext(backgroundSource, context)
  await clickHandler({ id: 42, url: "https://example.com/" })
  assert.equal(called, false)
})
