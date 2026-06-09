// Content script injected into Google Sheets pages.
// Exposes two RPCs to the popup:
//   - SHEETS_READ_ROW : reads the active cell + the two cells to the right.
//   - SHEETS_WRITE_LINK : writes a value into a specific A1-notation cell.
//
// Implementation notes (read carefully — this is fragile by nature):
// Sheets renders cell content on a <canvas>, so we cannot read cell values from
// the DOM directly. The two real DOM elements that mirror the active cell are:
//   - The Name Box (top-left): shows the active cell ref ("A5"). It is also
//     an input — typing a ref into it and pressing Enter navigates Sheets.
//   - The formula bar: shows the active cell's literal value/formula. It is
//     a contentEditable element.
// We use the Name Box to drive selection and the formula bar to read/write
// values. Selectors below try several known IDs; Sheets renames these from
// time to time.

(() => {
  const NAME_BOX_SELECTORS = [
    "input.waffle-name-box",
    "#t-name-box",
    'div[aria-label="Name box"] input',
    '[aria-label="Name box"] input',
    '[aria-label="Name box"]',
  ];
  const FORMULA_BAR_SELECTORS = [
    "#t-formula-bar-input",
    '[aria-label="Formula bar input"]',
    "#waffle-rich-text-editor",
    ".cell-input",
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const pickFirst = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };

  const getNameBox = () => pickFirst(NAME_BOX_SELECTORS);
  const getFormulaBar = () => pickFirst(FORMULA_BAR_SELECTORS);

  const readText = (el) => {
    if (!el) return "";
    if (el.value !== undefined && el.tagName === "INPUT") return String(el.value);
    return String(el.innerText || el.textContent || "");
  };

  // --- A1 ref parsing ---------------------------------------------------

  function parseRef(ref) {
    // Accepts "A5", "AB12", "'Sheet name'!A5", or "Sheet2!A5"
    const m = String(ref || "").trim().match(/^(?:('?)([^'!]+)\1!)?([A-Z]+)(\d+)$/);
    if (!m) return null;
    return { sheet: m[2] || "", col: m[3], row: parseInt(m[4], 10) };
  }

  function colToNum(col) {
    let n = 0;
    for (const c of col) n = n * 26 + (c.charCodeAt(0) - 64);
    return n;
  }
  function numToCol(n) {
    let s = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function offset(parsed, dCol, dRow) {
    const col = numToCol(colToNum(parsed.col) + dCol);
    const row = parsed.row + dRow;
    const prefix = parsed.sheet ? `${parsed.sheet.includes(" ") ? `'${parsed.sheet}'` : parsed.sheet}!` : "";
    return `${prefix}${col}${row}`;
  }

  // --- Navigation + read/write -----------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
  }

  function fireKey(el, key) {
    const opts = { key, code: key, bubbles: true, cancelable: true };
    if (key === "Enter") { opts.keyCode = 13; opts.which = 13; }
    if (key === "Escape") { opts.keyCode = 27; opts.which = 27; }
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function navigateTo(ref) {
    const nb = getNameBox();
    if (!nb) throw new Error("Could not find Sheets Name Box (selector drift?). Try reloading the sheet.");
    nb.focus();
    if (nb.tagName === "INPUT") {
      setNativeValue(nb, ref);
      nb.dispatchEvent(new Event("input", { bubbles: true }));
      nb.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      nb.textContent = ref;
      nb.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    fireKey(nb, "Enter");
    await sleep(280);
  }

  async function readCurrentCellValue() {
    // Give Sheets a tick to settle the formula bar after a navigation.
    await sleep(60);
    const fb = getFormulaBar();
    if (!fb) throw new Error("Could not find Sheets formula bar.");
    return readText(fb).trim();
  }

  // Writing to a Sheets cell is hard because cell content lives on a <canvas>,
  // not in the DOM. The popup pre-loads the value into the system clipboard
  // (the popup is window-focused; this content script is not, so we can't
  // write to the clipboard from here). We then try paste strategies in order
  // and verify by reading back the target cell.
  async function writeValueToCell(targetRef, value, fromClipboard) {
    const str = String(value);
    const errors = [];

    // Strategy 1: synthetic paste event carrying the value in clipboardData.
    // Some sites read paste data from the event itself.
    await navigateTo(targetRef);
    await sleep(120);
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", str);
      const paste = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      const target = document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document.body;
      target.dispatchEvent(paste);
      await sleep(400);
      if (await verifyCellEquals(targetRef, str)) return;
    } catch (e) {
      errors.push("synthetic paste: " + (e.message || String(e)));
    }

    // Strategy 2: click into the formula bar so Sheets enters edit mode, then
    // ask the browser to paste from the system clipboard (the popup put the
    // value there). Requires "clipboardRead" permission.
    if (fromClipboard) {
      await navigateTo(targetRef);
      await sleep(120);
      try {
        const fb = getFormulaBar();
        if (!fb) throw new Error("formula bar not found");
        clickElement(fb);
        await sleep(220);
        const ok = document.execCommand("paste");
        await sleep(120);
        fireKey(fb, "Enter");
        fireKey(document, "Enter");
        await sleep(280);
        if (await verifyCellEquals(targetRef, str)) return;
        if (!ok) errors.push("execCommand paste returned false");
      } catch (e) {
        errors.push("execCommand paste: " + (e.message || String(e)));
      }
    }

    // Strategy 3: click formula bar, select all, insertText, Enter.
    await navigateTo(targetRef);
    await sleep(120);
    try {
      const fb = getFormulaBar();
      if (!fb) throw new Error("formula bar not found");
      clickElement(fb);
      await sleep(220);
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(fb);
      sel.addRange(range);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, str);
      await sleep(80);
      fireKey(fb, "Enter");
      fireKey(document, "Enter");
      await sleep(280);
      if (await verifyCellEquals(targetRef, str)) return;
    } catch (e) {
      errors.push("insertText: " + (e.message || String(e)));
    }

    throw new Error("Write did not commit. Tried: " + errors.join(" | "));
  }

  function clickElement(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + Math.max(2, rect.width / 2);
    const y = rect.top + Math.max(2, rect.height / 2);
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    el.focus();
  }

  async function verifyCellEquals(targetRef, expected) {
    // Enter usually moves selection one row down; navigate back to read.
    await navigateTo(targetRef);
    await sleep(150);
    const got = await readCurrentCellValue();
    return String(got).trim() === String(expected).trim();
  }

  // --- RPCs ------------------------------------------------------------

  async function readRow() {
    const nb = getNameBox();
    if (!nb) throw new Error("Could not find Sheets Name Box.");
    const startRef = readText(nb).trim();
    if (!startRef) throw new Error("No active cell.");
    // If a range is selected ("A5:B6"), use the anchor.
    const anchorRef = startRef.split(":")[0];
    const parsed = parseRef(anchorRef);
    if (!parsed) throw new Error("Could not parse active cell ref: " + startRef);

    const name = await readCurrentCellValue();
    const rightRef = offset(parsed, 1, 0);
    await navigateTo(rightRef);
    const startDate = await readCurrentCellValue();

    const right2Ref = offset(parsed, 2, 0);
    await navigateTo(right2Ref);
    const endDate = await readCurrentCellValue();

    // Navigate back to the original cell so the user's selection looks unchanged.
    await navigateTo(anchorRef);

    return {
      ref: anchorRef,
      name,
      startDate,
      endDate,
      belowRef: offset(parsed, 0, 1),
      twoBelowRef: offset(parsed, 0, 2),
    };
  }

  async function writeLink({ cellRef, value, fromClipboard }) {
    await writeValueToCell(cellRef, value || "", !!fromClipboard);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "SHEETS_READ_ROW") {
      readRow()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
    if (msg.type === "SHEETS_WRITE_LINK") {
      writeLink(msg)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
    return false;
  });
})();
