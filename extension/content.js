// Content script: runs on iapps.courts.state.ny.us/nyscef/*.
// Two roles depending on which page we land on:
//   1) Search form page: fill First/Last + optional date range, submit.
//   2) Results page: scrape the result rows.
//
// The form submit causes a navigation, so we use sessionStorage on the tab to
// remember "we're mid-search, scrape when the next page loads".

(() => {
  const PENDING_KEY = "nyscef_batch_pending";
  const NAME_KEY = "nyscef_batch_name";

  function findFirstNameField() {
    const candidates = [
      "input[name='txtFirstName']",
      "input[id='txtFirstName']",
      "input[name*='First' i]",
      "input[id*='First' i]",
      "input[name*='first' i]",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return findByLabel(/first\s*name/i);
  }

  function findLastNameField() {
    const candidates = [
      "input[name='txtLastName']",
      "input[id='txtLastName']",
      "input[name*='Last' i]",
      "input[id*='Last' i]",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return findByLabel(/last\s*name/i);
  }

  function findStartDateField() {
    const candidates = [
      "input[name*='StartDate' i]",
      "input[id*='StartDate' i]",
      "input[name*='DateFrom' i]",
      "input[id*='DateFrom' i]",
      "input[name*='FilingDateFrom' i]",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return findByLabel(/start\s*date|filing\s*date.*from|date.*from|from.*date/i);
  }

  function findEndDateField() {
    const candidates = [
      "input[name*='EndDate' i]",
      "input[id*='EndDate' i]",
      "input[name*='DateTo' i]",
      "input[id*='DateTo' i]",
      "input[name*='FilingDateTo' i]",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return findByLabel(/end\s*date|filing\s*date.*to|date.*to|to.*date|thru/i);
  }

  function findByLabel(regex) {
    const labels = Array.from(document.querySelectorAll("label, td, th, span, div"));
    for (const lab of labels) {
      const text = (lab.textContent || "").trim();
      if (!regex.test(text)) continue;
      if (lab.tagName === "LABEL" && lab.htmlFor) {
        const target = document.getElementById(lab.htmlFor);
        if (target && target.tagName === "INPUT") return target;
      }
      let sib = lab.nextElementSibling;
      while (sib) {
        if (sib.tagName === "INPUT" && sib.type !== "hidden") return sib;
        const nested = sib.querySelector && sib.querySelector("input:not([type='hidden'])");
        if (nested) return nested;
        sib = sib.nextElementSibling;
      }
      const row = lab.closest("tr");
      if (row) {
        const input = row.querySelector("input:not([type='hidden'])");
        if (input) return input;
      }
    }
    return null;
  }

  function findSubmitButton(form) {
    const scope = form || document;
    const candidates = [
      "input[type='submit'][value*='Search' i]",
      "button[type='submit']",
      "input[type='submit']",
      "button:not([type='button'])",
    ];
    for (const sel of candidates) {
      const el = scope.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isFormPage() {
    return !!(findFirstNameField() && findLastNameField());
  }

  function looksLikeResultsPage() {
    const body = (document.body && document.body.innerText) || "";
    if (/search\s+results/i.test(body)) return true;
    if (/results?\s+returned/i.test(body)) return true;
    if (/no\s+matches/i.test(body) || /no\s+results/i.test(body)) return true;
    return !!findResultsTable();
  }

  function setReactNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillAndSubmit(first, last, startDate, endDate) {
    const firstEl = findFirstNameField();
    const lastEl = findLastNameField();
    if (!firstEl || !lastEl) throw new Error("Could not locate First/Last name fields on the page.");
    setReactNativeValue(firstEl, first);
    setReactNativeValue(lastEl, last);

    if (startDate) {
      const startEl = findStartDateField();
      if (startEl) setReactNativeValue(startEl, startDate);
    }
    if (endDate) {
      const endEl = findEndDateField();
      if (endEl) setReactNativeValue(endEl, endDate);
    }

    const form = firstEl.closest("form") || lastEl.closest("form");
    const submit = findSubmitButton(form);

    try {
      sessionStorage.setItem(PENDING_KEY, "1");
      sessionStorage.setItem(NAME_KEY, JSON.stringify({ first, last, startDate, endDate }));
    } catch (_) {}

    if (submit) {
      submit.click();
    } else if (form) {
      form.submit();
    } else {
      throw new Error("Could not find a submit control for the search form.");
    }
  }

  function findResultsTable() {
    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, bestScore = 0;
    const caseRe = /\b[A-Z0-9]+[-\/]\d{2,4}\b|\b\d{3,}[-\/]\d{2,4}\b/;
    for (const t of tables) {
      const rows = t.querySelectorAll("tr");
      let score = 0;
      for (const r of rows) {
        if (caseRe.test(r.textContent || "")) score++;
      }
      if (score > bestScore) { best = t; bestScore = score; }
    }
    return bestScore >= 1 ? best : null;
  }

  function scrapeResults() {
    const table = findResultsTable();
    if (!table) {
      const bodyText = (document.body && document.body.innerText || "").trim();
      const msgMatch = bodyText.match(/no\s+(matches|results|cases)[^\n]*/i);
      return { count: 0, summary: msgMatch ? msgMatch[0] : "No results table found.", cases: [] };
    }
    const headers = headerCells(table);
    const headerNorm = headers.map((h) => h.toLowerCase());
    const colIdx = (names) => {
      for (const n of names) {
        const i = headerNorm.findIndex((h) => h.includes(n));
        if (i !== -1) return i;
      }
      return -1;
    };
    const idxCase = colIdx(["case", "index", "docket"]);
    const idxCaption = colIdx(["caption", "title", "name"]);
    const idxCourt = colIdx(["court"]);
    const idxFiled = colIdx(["filed", "filing", "date"]);

    const rows = Array.from(table.querySelectorAll("tr"));
    const cases = [];
    for (const tr of rows) {
      const cells = Array.from(tr.children).filter((c) => c.tagName === "TD");
      if (!cells.length) continue;
      const texts = cells.map((c) => (c.innerText || c.textContent || "").trim().replace(/\s+/g, " "));
      const rowText = texts.join(" | ");
      if (!/[A-Za-z0-9]/.test(rowText)) continue;
      const link = (tr.querySelector("a[href]") || {}).href || "";
      const caseNumber = idxCase >= 0 ? texts[idxCase] : firstMatch(rowText, /\b[\w-]+\/\d{2,4}\b/);
      const caption = idxCaption >= 0 ? texts[idxCaption] : "";
      const court = idxCourt >= 0 ? texts[idxCourt] : "";
      const filed = idxFiled >= 0 ? texts[idxFiled] : "";
      if (!caseNumber && !caption) continue;
      cases.push({ caseNumber, caption, court, filed, link, raw: rowText });
    }
    const summary = cases.length
      ? cases.slice(0, 3).map((c) => c.caseNumber || c.caption || c.raw).join("; ") + (cases.length > 3 ? `; +${cases.length - 3} more` : "")
      : "No case rows extracted.";
    return { count: cases.length, summary, cases };
  }

  function headerCells(table) {
    const ths = table.querySelectorAll("thead th, tr:first-child th");
    if (ths.length) return Array.from(ths).map((t) => (t.innerText || t.textContent || "").trim());
    const firstRow = table.querySelector("tr");
    if (!firstRow) return [];
    return Array.from(firstRow.children).map((c) => (c.innerText || c.textContent || "").trim());
  }

  function firstMatch(s, re) {
    const m = s.match(re);
    return m ? m[0] : "";
  }

  let pending = false;
  try { pending = sessionStorage.getItem(PENDING_KEY) === "1"; } catch (_) {}

  if (pending) {
    waitFor(() => looksLikeResultsPage() || document.readyState === "complete", 15000)
      .then(() => {
        const result = scrapeResults();
        try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
        try { sessionStorage.removeItem(NAME_KEY); } catch (_) {}
        chrome.runtime.sendMessage({ type: "SEARCH_RESULT", result });
      })
      .catch((err) => {
        try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
        chrome.runtime.sendMessage({ type: "SEARCH_ERROR", error: err.message || String(err) });
      });
    return;
  }

  if (isFormPage()) {
    chrome.runtime.sendMessage({ type: "CONTENT_READY" });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "DO_SEARCH") {
        try {
          fillAndSubmit(msg.first || "", msg.last || "", msg.startDate || "", msg.endDate || "");
          sendResponse({ ok: true });
        } catch (err) {
          chrome.runtime.sendMessage({ type: "SEARCH_ERROR", error: err.message });
          sendResponse({ ok: false, error: err.message });
        }
      }
      return false;
    });
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (predicate()) return resolve();
      const start = Date.now();
      const iv = setInterval(() => {
        if (predicate()) { clearInterval(iv); resolve(); return; }
        if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error("timeout waiting for results page")); }
      }, 200);
    });
  }
})();
