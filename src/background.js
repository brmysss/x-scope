const X_PAGE_PATTERN = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//

async function sendToggleMessage(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "toggle-panel" })
    return true
  } catch {
    return false
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !X_PAGE_PATTERN.test(tab.url || "")) return

  if (await sendToggleMessage(tab.id)) return

  try {
    // Tabs that were already open when the extension was installed may not have
    // received the declarative content script yet. Inject it on demand so the
    // toolbar button always has a useful first action.
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["src/styles.css"],
    })
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/core.js", "src/content-script.js"],
    })
    await sendToggleMessage(tab.id)
  } catch (error) {
    console.warn("XScope could not inject into this tab", error)
  }
})
