// Popup controller: drives both modes — highlighted cell and batch.

const $ = (id) => document.getElementById(id);
const sheetUrlInput = $("sheetUrl");
const loadBtn = $("load");
const preview = $("preview");
const rowCountEl = $("rowcount");
const firstColEl = $("firstCol");
const lastColEl = $("lastCol");
const startBtn = $("start");
const stopBtn = $("stop");
const delayInput = $("delay");
const closeTabsInput = $("closeTabs");
const progressEl = $("progress");
const barfill = $("barfill");
const progressText = $("progressText");
const logEl = $("log");
const sheetsStatus = $("sheetsStatus");
const searchHighlightedBtn = $("searchHighlighted");

const SEARCH_URL = "https://iapps.courts.state.ny.us/nyscef/CaseSearch?TAB=name";

let rows = [];
let running = false;
let stopRequested = false;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(done, total) {
  progressEl.classList.remove("hidden");
  const pct = total ? Math.round((done / total) * 100) : 0;
  barfill.style.width = pct + "%";
  progressText.textContent = `${done} / ${total}`;
}

function buildExportUrl(input) {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Paste a Google Sheet URL.");
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) {
    return `https://docs.google.com/spreadsheets/d/${raw}/export?format=csv`;
  }
  const m = raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("That doesn't look like a Google Sheet URL.");
  const id = m[1];
  const gidMatch = raw.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : null;
  let url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  if (gid) url += `&gid=${gid}`;
  return url;
}

function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cur.push(field); field = "";
      } else if (c === "\n") {
        cur.push(field); field = "";
        rows.push(cur); cur = [];
      } else if (c === "\r") {
        // ignore
      } else {
        field += c;
      }
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}

function findColumn(header, candidates) {
  const norm = header.map(normalize);
  for (const cand of candidates) {
    const c = normalize(cand);
    const idx = norm.indexOf(c);
    if (idx !== -1) return idx;
  }
  for (let i = 0; i < norm.length; i++) {
    for (const cand of candidates) {
      if (norm[i].includes(normalize(cand))) return i;
    }
  }
  return -1;
}

loadBtn.addEventListener("click", async () => {
  preview.classList.add("hidden");
  startBtn.disabled = true;
  let url;
  try {
    url = buildExportUrl(sheetUrlInput.value);
  } catch (err) {
    log(err.message);
    return;
  }
  log("Fetching " + url);
  let text;
  try {
    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — is the sheet shared as 'Anyone with the link'?`);
    text = await resp.text();
  } catch (err) {
    log("Fetch failed: " + err.message);
    return;
  }
  if (/<html|sign in|signin/i.test(text.slice(0, 500)) && !text.split("\n")[0].includes(",")) {
    log("Got an HTML page instead of CSV. Make sure the sheet is shared as 'Anyone with the link · Viewer'.");
    return;
  }
  const aoa = parseCsv(text);
  if (!aoa.length) { log("Sheet appears empty."); return; }
  const headerRow = aoa[0].map(String);
  const dataRows = aoa.slice(1);
  const firstIdx = findColumn(headerRow, ["first name", "firstname", "first", "given name"]);
  const lastIdx = findColumn(headerRow, ["last name", "lastname", "last", "surname", "family name"]);
  firstColEl.textContent = firstIdx >= 0 ? headerRow[firstIdx] : "NOT FOUND";
  lastColEl.textContent = lastIdx >= 0 ? headerRow[lastIdx] : "NOT FOUND";
  preview.classList.remove("hidden");

  if (firstIdx < 0 || lastIdx < 0) {
    log("Could not detect First Name / Last Name columns. Header was: " + JSON.stringify(headerRow));
    rows = [];
    rowCountEl.textContent = "0";
    return;
  }
  rows = dataRows
    .map((r, i) => ({
      first: String(r[firstIdx] || "").trim(),
      last: String(r[lastIdx] || "").trim(),
      _rowIdx: i,
    }))
    .filter((r) => r.first || r.last);
  rowCountEl.textContent = rows.length;
  startBtn.disabled = rows.length === 0;
  log(`Loaded ${rows.length} name row(s).`);
});

startBtn.addEventListener("click", async () => {
  if (running) return;
  running = true;
  stopRequested = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  const delaySec = Math.max(0, parseInt(delayInput.value, 10) || 0);
  const closeTabs = closeTabsInput.checked;

  setProgress(0, rows.length);
  log(`Starting batch of ${rows.length} rows. Delay ${delaySec}s. Close tabs: ${closeTabs}.`);

  for (let i = 0; i < rows.length; i++) {
    if (stopRequested) { log("Stopped by user."); break; }
    const row = rows[i];
    log(`(${i + 1}/${rows.length}) Searching "${row.first} ${row.last}"`);
    try {
      const res = await runOne(row, closeTabs);
      log(`  -> ${res.count} result(s): ${res.summary.slice(0, 120)}`);
    } catch (err) {
      log(`  !! error: ${err.message}`);
    }
    setProgress(i + 1, rows.length);
    if (delaySec && i < rows.length - 1) await sleep(delaySec * 1000);
  }

  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  log("Batch complete.");
});

stopBtn.addEventListener("click", () => {
  stopRequested = true;
  stopBtn.disabled = true;
  log("Stop requested — will halt after the current row.");
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runOne(row, closeTab) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "RUN_SEARCH",
        first: row.first,
        last: row.last,
        startDate: row.startDate || "",
        endDate: row.endDate || "",
        closeTab,
        url: SEARCH_URL,
      },
      (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error("No response from background"));
        if (resp.error) return reject(new Error(resp.error));
        resolve(resp.result);
      }
    );
  });
}

// --- Highlighted-cell mode -------------------------------------------

async function detectSheetsTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /^https:\/\/docs\.google\.com\/spreadsheets\//.test(tab.url || "")) return tab;
  return null;
}

function formatDateForNyscef(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const mo = m[1].padStart(2, "0");
    const da = m[2].padStart(2, "0");
    let yr = m[3];
    if (yr.length === 2) yr = (parseInt(yr, 10) > 50 ? "19" : "20") + yr;
    return `${mo}/${da}/${yr}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}/${m[1]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${mo}/${da}/${d.getFullYear()}`;
  }
  return s;
}

function sendToTabOnce(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error("No response from tab"));
      if (!resp.ok) return reject(new Error(resp.error || "tab returned error"));
      resolve(resp.data);
    });
  });
}

async function ensureSheetsContentScript(tabId) {
  // If the extension was reloaded after the tab was opened, Chrome doesn't
  // auto-inject the content script. Inject on demand. Idempotent.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["sheets.js"] });
}

async function sendToTab(tabId, msg) {
  try {
    return await sendToTabOnce(tabId, msg);
  } catch (err) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(err.message)) throw err;
    await ensureSheetsContentScript(tabId);
    await new Promise((r) => setTimeout(r, 100));
    return await sendToTabOnce(tabId, msg);
  }
}

async function initSheetsMode() {
  const tab = await detectSheetsTab();
  if (tab) {
    sheetsStatus.textContent = "Google Sheets tab detected — ready.";
    sheetsStatus.classList.add("ok");
    searchHighlightedBtn.disabled = false;
  } else {
    sheetsStatus.textContent = "No Google Sheets tab is active. Switch to your sheet, then reopen this popup.";
    sheetsStatus.classList.add("warn");
    searchHighlightedBtn.disabled = true;
  }
}

searchHighlightedBtn.addEventListener("click", async () => {
  searchHighlightedBtn.disabled = true;
  try {
    const tab = await detectSheetsTab();
    if (!tab) { log("Active tab is not Google Sheets."); return; }

    log("Reading active cell…");
    let info;
    try {
      info = await sendToTab(tab.id, { type: "SHEETS_READ_ROW" });
    } catch (err) {
      log("Could not read sheet: " + err.message);
      log("Tip: open the sheet, click into a cell once, then reopen this popup.");
      return;
    }
    log(`Cell ${info.ref}: "${info.name}" | start "${info.startDate}" | end "${info.endDate}"`);

    if (!info.name || !info.name.includes("//")) {
      log("Active cell must contain First//Last. Got: " + JSON.stringify(info.name));
      return;
    }
    const parts = info.name.split("//").map((s) => s.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      log("Active cell must have both first and last separated by //.");
      return;
    }
    const first = parts[0];
    const last = parts[1];
    const startDate = formatDateForNyscef(info.startDate);
    const endDate = formatDateForNyscef(info.endDate);
    if (!startDate || !endDate) {
      log("Need both start and end dates in the cells to the right.");
      return;
    }

    log(`Searching NYSCEF: ${first} ${last}  ${startDate}–${endDate}`);
    let result;
    try {
      result = await runOne({ first, last, startDate, endDate }, false);
    } catch (err) {
      log("Search failed: " + err.message);
      return;
    }
    log(`Got ${result.count} result(s).`);
    const link = (result.cases && result.cases[0] && result.cases[0].link) || "";
    if (!link) {
      log("No link to write (no results).");
      return;
    }
    // Copy the link to the clipboard from the POPUP (the popup is focused;
    // the content script in the Sheets tab is not, so it can't write).
    let clipboardOk = false;
    try {
      await navigator.clipboard.writeText(link);
      clipboardOk = true;
    } catch (e) {
      log("Could not copy link to clipboard: " + e.message);
    }

    log(`Writing link to ${info.belowRef}…`);
    try {
      await sendToTab(tab.id, {
        type: "SHEETS_WRITE_LINK",
        cellRef: info.belowRef,
        value: link,
        fromClipboard: clipboardOk,
      });
      log("Case link written. ✓");
    } catch (err) {
      log("Auto-paste failed: " + err.message);
      if (clipboardOk) {
        log(`The link is in your clipboard. Click cell ${info.belowRef} and press Ctrl+V (Cmd+V on Mac).`);
      } else {
        log("Link: " + link);
      }
    }
  } finally {
    searchHighlightedBtn.disabled = false;
  }
});

initSheetsMode();
