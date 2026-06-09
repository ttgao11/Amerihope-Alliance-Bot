// Content script: runs on iapps.courts.state.ny.us/nyscef/*.
// Two roles depending on which page we land on:
//   1) Search form page: fill First/Last, submit.
//   2) Results page: scrape the result rows.
//
// The form submit causes a navigation, so we use sessionStorage on the tab to
// remember "we're mid-search, scrape when the next page loads".

(() => {
  const PENDING_KEY = "nyscef_batch_pending";
  const NAME_KEY = "nyscef_batch_name";

  // --- Detect role -------------------------------------------------------

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
      // for=… on a label
      if (lab.tagName === "LABEL" && lab.htmlFor) {
        const target = document.getElementById(lab.htmlFor);
        if (target && target.tagName === "INPUT") return target;
      }
      // sibling input
      let sib = lab.nextElementSibling;
      while (sib) {
        if (sib.tagName === "INPUT" && sib.type !== "hidden") return sib;
        const nested = sib.querySelector && sib.querySelector("input:not([type='hidden'])");
        if (nested) return nested;
        sib = sib.nextElementSibling;
      }
      // input inside the same row (td/th)
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

  function isNyscefNonFormPage() {
    // Anything on iapps.courts.state.ny.us/nyscef/ that isn't the search form.
    return location.pathname.includes("/nyscef/") && !isFormPage();
  }

  const CASE_RE = /case\s*#|case\s*number|index\s*#|index\s*number|docket\s*#|docket\s*number/i;
  const DATE_RE = /received\s*date|filed\s*date|filing\s*date|date\s*filed|date\s*received/i;

  // Step 1: find the link under "Case #" / "Received Date". Try several
  // strategies in order so the matcher is robust against layout variations.
  function findCaseNumberLink() {
    // Strategy A: a table whose header row has both case-# and date headers,
    //             then the first link in any subsequent row.
    const tables = Array.from(document.querySelectorAll("table"));
    for (const t of tables) {
      const rows = Array.from(t.querySelectorAll("tr"));
      let headerRowIdx = -1;
      for (let r = 0; r < rows.length; r++) {
        const cells = Array.from(rows[r].children).filter((c) => c.tagName === "TH" || c.tagName === "TD");
        const texts = cells.map((c) => (c.innerText || c.textContent || "").trim());
        const hasCase = texts.some((h) => CASE_RE.test(h));
        const hasDate = texts.some((h) => DATE_RE.test(h));
        if (hasCase && hasDate) { headerRowIdx = r; break; }
      }
      if (headerRowIdx >= 0) {
        for (let r = headerRowIdx + 1; r < rows.length; r++) {
          const a = rows[r].querySelector("a[href]");
          if (a) return a.href;
        }
      }
    }

    // Strategy B: any element labelled "Case #" — find the nearest link below
    //             or after it. Handles label/value pairs and divs.
    const candidates = Array.from(document.querySelectorAll("th, td, label, span, div, b, strong, h1, h2, h3"));
    for (const el of candidates) {
      if (el.children.length > 4) continue; // skip large containers
      const text = (el.innerText || el.textContent || "").trim();
      if (!CASE_RE.test(text)) continue;
      // 1) same row (table)
      const row = el.closest("tr");
      if (row) {
        const nextRow = row.nextElementSibling;
        if (nextRow) {
          const a = nextRow.querySelector("a[href]");
          if (a) return a.href;
        }
        const a = row.querySelector("a[href]");
        if (a) return a.href;
      }
      // 2) sibling tree
      let sib = el.nextElementSibling;
      while (sib) {
        if (sib.tagName === "A" && sib.href) return sib.href;
        const a = sib.querySelector && sib.querySelector("a[href]");
        if (a) return a.href;
        sib = sib.nextElementSibling;
      }
      // 3) parent's next sibling
      const parent = el.parentElement;
      if (parent && parent.nextElementSibling) {
        const a = parent.nextElementSibling.querySelector("a[href]");
        if (a) return a.href;
      }
    }

    // Strategy C: any link whose href looks like a case-detail URL on NYSCEF.
    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const a of links) {
      if (/CaseDetails|CaseStatus|ShowDocket|caseDetail/i.test(a.href)) return a.href;
    }

    return null;
  }

  // Diagnostic snapshot when step 1 fails: dump table headers + first links
  // so we can see what the page actually looks like and adjust the matchers.
  function gatherDiagnostic() {
    const tables = Array.from(document.querySelectorAll("table")).slice(0, 4);
    const tableInfo = tables.map((t, i) => {
      const rows = Array.from(t.querySelectorAll("tr")).slice(0, 3);
      return rows.map((r, ri) => {
        const cells = Array.from(r.children).map((c) =>
          (c.innerText || c.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)
        );
        return `  T${i}R${ri}: ${cells.join(" | ")}`;
      }).join("\n");
    }).join("\n");
    const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 12);
    const linkInfo = links.map((a, i) => {
      const text = (a.innerText || a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const href = a.href.length > 80 ? a.href.slice(0, 80) + "…" : a.href;
      return `  L${i}: "${text}" -> ${href}`;
    }).join("\n");
    return `URL: ${location.href}\nTABLES (first 4):\n${tableInfo || "  (none)"}\nLINKS (first 12):\n${linkInfo || "  (none)"}`;
  }

  // Step 2: find the link whose text reads "SUMMONS + COMPLAINT" (or close
  // variants — "and"/"&" instead of "+", any whitespace, any casing).
  function findSummonsLink() {
    const re = /summons\s*(?:\+|and|&)\s*complaint/i;
    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const a of links) {
      const text = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      if (re.test(text)) return a.href;
    }
    return null;
  }

  // Both step-1 and step-2 may need a brief retry while the page hydrates.
  async function waitForFinder(finder, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const out = finder();
      if (out) return out;
      await new Promise((r) => setTimeout(r, 250));
    }
    return finder();
  }

  function looksLikeResultsPage() {
    // Results pages usually mention "Search Results", "Results Returned", or list cases.
    const body = (document.body && document.body.innerText) || "";
    if (/search\s+results/i.test(body)) return true;
    if (/results?\s+returned/i.test(body)) return true;
    if (/no\s+matches/i.test(body) || /no\s+results/i.test(body)) return true;
    // Tables with what look like NYSCEF case numbers
    return !!findResultsTable();
  }

  // --- Form fill + submit -----------------------------------------------

  function setReactNativeValue(el, value) {
    // Bypass framework-controlled inputs by setting the native setter.
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

    // Mark this tab as mid-search so when the results page loads we scrape it.
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

  // --- Results scraping --------------------------------------------------

  function findResultsTable() {
    // Heuristic: find the table with the most rows whose cells contain text resembling
    // an NYSCEF case identifier (e.g. "654321/2024", letter-digit combos with slashes).
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
      // No table — could be "no matches found" message.
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
      // skip rows that are header/footer or empty
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
    // fall back to the first <tr>
    const firstRow = table.querySelector("tr");
    if (!firstRow) return [];
    return Array.from(firstRow.children).map((c) => (c.innerText || c.textContent || "").trim());
  }

  function firstMatch(s, re) {
    const m = s.match(re);
    return m ? m[0] : "";
  }

  // --- Wire up to background --------------------------------------------

  let pending = false;
  try { pending = sessionStorage.getItem(PENDING_KEY) === "1"; } catch (_) {}

  if (pending) {
    // We just navigated from a submitted search. Scrape and report.
    // Give the page a moment to settle (in case of async rendering).
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

  if (isNyscefNonFormPage()) {
    // Background opened this tab as part of the two-step doc fetch. It will
    // tell us whether to look for the case-number link or the SUMMONS +
    // COMPLAINT link.
    chrome.runtime.sendMessage({ type: "CONTENT_READY" });
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === "FIND_CASE_LINK") {
        waitForFinder(findCaseNumberLink, 12000)
          .then((link) => {
            const diagnostic = link ? null : gatherDiagnostic();
            chrome.runtime.sendMessage({ type: "CASE_LINK_FOUND", link, diagnostic });
            sendResponse({ ok: true });
          })
          .catch((err) => {
            chrome.runtime.sendMessage({ type: "CASE_LINK_ERROR", error: err.message });
            sendResponse({ ok: false, error: err.message });
          });
        return true;
      }
      if (msg.type === "FIND_DOC_LINK") {
        waitForFinder(findSummonsLink, 12000)
          .then((link) => {
            const diagnostic = link ? null : gatherDiagnostic();
            chrome.runtime.sendMessage({ type: "DOC_LINK_FOUND", link, diagnostic });
            sendResponse({ ok: true });
          })
          .catch((err) => {
            chrome.runtime.sendMessage({ type: "DOC_LINK_ERROR", error: err.message });
            sendResponse({ ok: false, error: err.message });
          });
        return true;
      }
      return false;
    });
    return;
  }

  if (isFormPage()) {
    // First load: tell background we're ready for a search.
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
  // Else: page is something else (e.g. a case detail page after the user clicked through).
  // We simply do nothing.

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
