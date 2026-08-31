chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-panel" })
  } catch {
    // The content script is not present on browser pages or before X finishes loading.
  }
})
