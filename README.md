# [placeholder]

A Chrome extension that tells shoppers on Amazon product pages whether to **Buy now** or **Wait**, based on a price-drop forecast from the Python backend in `backend/`.

## Loading the extension (development)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `extension/` folder (the one containing `manifest.json`).
4. Optional: pin it from the puzzle-piece Extensions menu so its icon stays in the toolbar.

### Reloading after changes

- **`manifest.json` or `content/content.js` changed:** click the reload (↻) icon on the extension's card in `chrome://extensions`, then **refresh any open Amazon tabs**. Already-open pages keep running the old content script until they're refreshed.
- **Popup files changed (`popup/*`):** just close and reopen the popup. The popup page is reloaded each time it opens.

If something fails to load, Chrome shows an **Errors** button on the extension's card with the details.

## Temporary product name

`[placeholder]` is a stand-in for the product name, which hasn't been chosen yet. Find-and-replace the exact string `[placeholder]` once it is. It appears in:

- `README.md` (title and this section)
- `extension/manifest.json` (`name` and `action.default_title`)
- `extension/content/content.js` (console log prefix)
- `extension/popup/popup.html` (`<title>` and `<h1>` heading)
- `extension/popup/popup.js` (console log prefix)
