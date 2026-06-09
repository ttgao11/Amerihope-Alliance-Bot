# NYSCEF Name Search — Chrome Extension

Two ways to drive the [NYSCEF Case Search by Name](https://iapps.courts.state.ny.us/nyscef/CaseSearch?TAB=name):

1. **Highlighted cell** — in Google Sheets, highlight a cell formatted `First//Last`. The cells to its right hold the filing **start date** and **end date**. The extension runs the search and writes the result link into the cell directly below.
2. **Batch from sheet URL** — paste a public sheet URL, the extension runs every row in turn.

> NYSCEF sits behind a Cloudflare browser challenge, so the search has to be driven through a real Chrome tab — that's why this is a Chrome extension and not a pure Google Sheets macro / Apps Script.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and pick the **`extension/`** subfolder of this repo (the folder that directly contains `manifest.json`).
4. Pin the extension to the toolbar.

## Mode 1 — Highlighted cell

Cell layout the extension expects:

| (active cell)   | + 1 right    | + 2 right  |
| --------------- | ------------ | ---------- |
| `John//Smith`   | `01/01/2024` | `12/31/2024` |
| (link goes here) |              |            |

Usage:

1. In Google Sheets, **click on the cell containing `First//Last`** so it is the active cell.
2. Click the extension icon. The popup confirms it detected the Sheets tab.
3. Click **Search highlighted cell**. The extension:
   - reads the active cell + the two cells to its right (start date, end date),
   - opens NYSCEF in a background tab and fills First/Last + the date range,
   - scrapes the first result's link,
   - writes the link into the cell directly below the name cell.

Date cells can be real Date values (`12/31/2024`), text (`12/31/2024`), or ISO (`2024-12-31`). The extension normalizes them to `mm/dd/yyyy` for NYSCEF.

**How writing back works** (because Sheets renders cells in canvas): the popup pre-copies the link to the system clipboard (the popup window is focused, so it can), then the content script in the Sheets tab navigates to the target cell via the Name Box and triggers a paste via three fallback strategies: a synthetic paste event, `document.execCommand('paste')` from the focused formula bar, and `insertText` + Enter. If all three fail, the link is still in your clipboard for manual Cmd+V.

## Mode 2 — Batch from sheet URL

1. In Google Sheets: **Share → General access → Anyone with the link → Viewer**. Copy the URL.
2. Open the extension popup, paste the URL into the batch section, click **Load sheet**.
3. The popup confirms the row count and which header columns it detected (First Name / Last Name; date columns are not read in this mode).
4. (Optional) adjust delay, choose whether to close each result tab after scraping.
5. Click **Start**. Results land in the popup log; each opened tab stays open by default.

Header variations accepted:

- First Name: `First`, `FirstName`, `Given Name`
- Last Name: `Last`, `LastName`, `Surname`, `Family Name`

## File layout

- `manifest.json` — MV3; host access to `iapps.courts.state.ny.us` and `docs.google.com`; `clipboardRead` / `clipboardWrite` permissions for the writeback path.
- `popup.html` / `popup.css` / `popup.js` — UI for both modes.
- `background.js` — opens NYSCEF tabs, brokers messages between popup and content scripts; threads `startDate`/`endDate` through to the form-fill step.
- `content.js` — on NYSCEF pages: fills First/Last + date range, submits, scrapes the results table.
- `sheets.js` — on `docs.google.com/spreadsheets/*`: reads the active cell + neighbors via the Name Box + formula bar; writes back via paste strategies.

## Troubleshooting

- **"Could not find Sheets Name Box / formula bar."** — Google updated the Sheets UI. Tell me what changed and I'll update the selectors in `sheets.js`.
- **"Could not locate First/Last name fields on the page."** — NYSCEF changed the search form. View the extension's service-worker logs (link from `chrome://extensions`), inspect the page, and share the new input `id`/`name`.
- **"Write did not commit. Tried: …"** — all three paste strategies failed. The link is still on your clipboard; paste it manually. Tell me which strategies failed and how, and I'll add a fourth.
- **The popup says "No Google Sheets tab is active"** even though I have Sheets open — Chrome's popup queries the *currently active* tab. Switch focus to the Sheets tab first, then click the extension icon.

## Notes

- Use responsibly. NYSCEF terms apply.
- Everything runs locally in your browser. The link to your sheet is never sent anywhere else.
