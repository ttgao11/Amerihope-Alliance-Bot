// Background service worker: bridges the popup and content scripts.
// For each row, opens a fresh tab, waits for the content script to ping ready,
// sends the search payload, then resolves when the scrape is done.

const pendingByTab = new Map();

const NAV_TIMEOUT_MS = 90_000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RUN_SEARCH") {
    handleRunSearch(msg)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }

  if (msg.type === "CONTENT_READY" && sender.tab) {
    const entry = pendingByTab.get(sender.tab.id);
    if (entry && !entry.searchSent) {
      entry.searchSent = true;
      chrome.tabs.sendMessage(sender.tab.id, {
        type: "DO_SEARCH",
        first: entry.payload.first,
        last: entry.payload.last,
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "SEARCH_RESULT" && sender.tab) {
    const entry = pendingByTab.get(sender.tab.id);
    if (entry) {
      clearTimeout(entry.timer);
      pendingByTab.delete(sender.tab.id);
      entry.resolve(msg.result);
      if (entry.closeTab) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 500);
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "SEARCH_ERROR" && sender.tab) {
    const entry = pendingByTab.get(sender.tab.id);
    if (entry) {
      clearTimeout(entry.timer);
      pendingByTab.delete(sender.tab.id);
      entry.reject(new Error(msg.error || "content script error"));
    }
    sendResponse({ ok: true });
    return false;
  }
});

async function handleRunSearch(msg) {
  const tab = await chrome.tabs.create({ url: msg.url, active: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByTab.delete(tab.id);
      reject(new Error("timed out waiting for search results"));
    }, NAV_TIMEOUT_MS);
    pendingByTab.set(tab.id, {
      resolve,
      reject,
      payload: { first: msg.first, last: msg.last },
      closeTab: !!msg.closeTab,
      timer,
      searchSent: false,
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = pendingByTab.get(tabId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingByTab.delete(tabId);
    entry.reject(new Error("tab was closed before results arrived"));
  }
});
