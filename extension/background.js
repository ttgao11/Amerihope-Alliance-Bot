// Background service worker: bridges the popup and content scripts.
// Handles two modes per tab:
//   - 'search'   : open the form page, fill First/Last + dates, scrape results.
//   - 'docfetch' : open a case docket page, find the first
//                  SUMMONS + COMPLAINT link, return its href.

const pendingByTab = new Map(); // tabId -> { resolve, reject, mode, payload, closeTab, timer, commandSent }

const NAV_TIMEOUT_MS = 90_000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RUN_SEARCH") {
    handleRunSearch(msg)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }

  if (msg.type === "RUN_FIND_DOC") {
    handleRunFindDoc(msg)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }

  if (msg.type === "CONTENT_READY" && sender.tab) {
    const entry = pendingByTab.get(sender.tab.id);
    if (entry && !entry.commandSent) {
      entry.commandSent = true;
      if (entry.mode === "search") {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: "DO_SEARCH",
          first: entry.payload.first,
          last: entry.payload.last,
          startDate: entry.payload.startDate || "",
          endDate: entry.payload.endDate || "",
        });
      } else if (entry.mode === "docfetch-step1") {
        chrome.tabs.sendMessage(sender.tab.id, { type: "FIND_CASE_LINK" });
      } else if (entry.mode === "docfetch-step2") {
        chrome.tabs.sendMessage(sender.tab.id, { type: "FIND_DOC_LINK" });
      }
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
      if (entry.closeTab) setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 500);
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

  if ((msg.type === "DOC_LINK_FOUND" || msg.type === "CASE_LINK_FOUND") && sender.tab) {
    const entry = pendingByTab.get(sender.tab.id);
    if (entry) {
      clearTimeout(entry.timer);
      pendingByTab.delete(sender.tab.id);
      entry.resolve({
        link: msg.link || null,
        links: msg.links || null,
        diagnostic: msg.diagnostic || null,
      });
      if (entry.closeTab) setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 500);
    }
    sendResponse({ ok: true });
    return false;
  }

  if ((msg.type === "DOC_LINK_ERROR" || msg.type === "CASE_LINK_ERROR") && sender.tab) {
    const entry = pendingByTab.get(sender.tab.id);
    if (entry) {
      clearTimeout(entry.timer);
      pendingByTab.delete(sender.tab.id);
      entry.reject(new Error(msg.error || "doc fetch error"));
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
      mode: "search",
      payload: {
        first: msg.first,
        last: msg.last,
        startDate: msg.startDate || "",
        endDate: msg.endDate || "",
      },
      closeTab: !!msg.closeTab,
      timer,
      commandSent: false,
    });
  });
}

async function handleRunFindDoc(msg) {
  // Open the case URL pasted into the sheet, collect every link in the
  // Document column, return them as an array.
  const res = await openTabForRole(msg.url, "docfetch-step2");
  const links = res && res.links ? res.links : (res && res.link ? [res.link] : []);
  return {
    links,
    diagnostic: res ? res.diagnostic : null,
    stage: links.length ? "ok" : "no-doc-links",
  };
}

async function openTabForRole(url, mode) {
  const tab = await chrome.tabs.create({ url, active: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByTab.delete(tab.id);
      reject(new Error(`timed out in ${mode}`));
    }, NAV_TIMEOUT_MS);
    pendingByTab.set(tab.id, {
      resolve,
      reject,
      mode,
      payload: {},
      closeTab: true,
      timer,
      commandSent: false,
    });
  });
}

// Clean up if a tab closes unexpectedly.
chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = pendingByTab.get(tabId);
  if (entry) {
    clearTimeout(entry.timer);
    pendingByTab.delete(tabId);
    entry.reject(new Error("tab was closed before results arrived"));
  }
});
