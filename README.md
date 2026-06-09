# NYSCEF Name Search Batch — Chrome Extension

A Chrome extension that reads first/last names from a public Google Sheet and runs each one through the
[NYSCEF Case Search by Name](https://iapps.courts.state.ny.us/nyscef/CaseSearch?TAB=name)
page, opening a tab per row. Results are scraped into the extension's popup log; the result tabs stay open so you can click into any case.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and pick the **`extension/`** subfolder of this repo (the folder that directly contains `manifest.json`).
4. Pin the extension to the toolbar.

## Prepare your Google Sheet

1. Open your sheet in Google Sheets.
2. **Share → General access → Anyone with the link → Viewer.** Copy the link.
3. Make sure the sheet has a header row with a **First Name** and **Last Name** column. Other columns are ignored.

Header variations the extension also accepts:

- First Name: `First`, `FirstName`, `Given Name`
- Last Name: `Last`, `LastName`, `Surname`, `Family Name`

If your sheet has multiple tabs, copy the URL while the tab you want is selected — the `gid=` in the URL identifies it. Without a `gid`, the first sheet is used.

## Usage

1. Click the extension icon to open the popup.
2. Paste the sheet URL into the input and click **Load sheet**. The popup confirms the row count and which header columns it detected.
3. (Optional) Adjust the delay between rows (default 3s) and whether to **close each results tab after scraping** (off by default).
4. Click **Start**. The extension opens one background tab per row, fills in First/Last, submits, and scrapes the results table. Per-row hit count + a short summary land in the popup's log.
5. Hit **Stop** to halt after the in-flight row.

## How it works

- `manifest.json` — Manifest V3; host access to `iapps.courts.state.ny.us` and `docs.google.com` (for fetching the CSV export of your sheet).
- `popup.html` / `popup.css` / `popup.js` — UI. Converts the sheet URL into a CSV export URL (`/export?format=csv&gid=…`), fetches it, parses CSV, runs the batch.
- `background.js` — service worker. For each row it opens a new tab, waits for the content script to ping `CONTENT_READY`, sends `DO_SEARCH`, resolves when `SEARCH_RESULT` comes back.
- `content.js` — injected into NYSCEF pages. On the form page it fills First/Last and submits. The submit causes a navigation, so a `sessionStorage` flag tells the next page load to scrape instead of waiting for a fresh search command.

The form-field and results-table detection uses fallbacks (selectors by `name`/`id`, label-text matching, and a case-number regex) rather than hard-coded IDs, so small markup tweaks on NYSCEF's side shouldn't immediately break it.

## Troubleshooting

- **"Got an HTML page instead of CSV"** — the sheet isn't shared publicly. Set Share → "Anyone with the link · Viewer" and try again.
- **"HTTP 404 / 401"** on fetch — the URL is wrong or sharing is set to "Restricted". Re-copy the URL from Google Sheets and re-check the share setting.
- **"Could not locate First/Last name fields on the page."** — NYSCEF changed the form. Open `chrome://extensions`, click the service-worker link to view logs, inspect the page, and tell me the input `id`/`name` so I can update `content.js`.
- **All rows return "No results table found."** — the page may now require a court/county selection before the search is valid. Let me know and I'll add those dropdowns to the popup and pass them through.
- **Timeouts** — bump the delay between rows; NYSCEF rate-limits.

## Notes

- Use responsibly — NYSCEF terms apply. Default 3-second delay between rows.
- The sheet is fetched client-side from your browser; nothing leaves your machine except the NYSCEF searches themselves.
