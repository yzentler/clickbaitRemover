# Debugging Guide for Spoiler (Clickbait Remover)

This guide provides step-by-step instructions on how to manually debug the Spoiler Chrome Extension.

## 1. Loading the Extension for Development

To debug the extension, you must load it into your browser in "Developer mode".

1. Open your Chromium-based browser (Chrome, Edge, Brave).
2. Navigate to `chrome://extensions/` (or `edge://extensions/`, etc.).
3. Toggle **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the root directory of this project (`clickbait-remover`).

**Note:** Whenever you make changes to the files (except for `content.js` injected dynamically or `popup.js`), you may need to click the **Reload** icon on the extension card in `chrome://extensions/` for changes to take effect.

## 2. Debugging the Background Service Worker (`background.js`)

The background script in Manifest V3 runs as a Service Worker. It handles context menus, API calls to LLMs, and state management.

1. Go to `chrome://extensions/`.
2. Locate the "Spoiler" extension.
3. Click on the **Inspect views: service worker** link.
4. This opens a dedicated Chrome DevTools window for the background script.
5. You can view `console.log()` outputs here, set breakpoints in `background.js` (under the **Sources** tab), and monitor network requests (under the **Network** tab) for calls to the LLM APIs.

*Tip:* If the service worker becomes inactive, interacting with the extension (e.g., using the context menu) will wake it up.

## 3. Debugging Content Scripts (`content.js`)

Content scripts run in the context of the web page you are viewing.

1. Navigate to a site where the extension operates (e.g., `israelhayom.co.il` or other supported news sites).
2. Right-click anywhere on the page and select **Inspect** to open DevTools.
3. **Console:** Any `console.log()` statements from `content.js` will appear here. Ensure the console filter is set to show messages from "All levels" and "All contexts".
4. **Sources:** To set breakpoints in your content script:
   - Go to the **Sources** tab.
   - Look in the left sidebar under the **Content scripts** tab (you may need to click the `>>` icon if it's hidden).
   - Find the "Spoiler" extension folder, open `content.js` (or related injected scripts), and set breakpoints as you would for normal web pages.

## 4. Debugging the Popup (`popup.html` / `popup.js`)

The popup is the UI that appears when you click the extension icon in the toolbar.

1. Click the "Spoiler" extension icon in your browser toolbar to open the popup.
2. Right-click anywhere inside the popup UI and select **Inspect**.
3. A new DevTools window will open specifically for the popup.
4. Use this DevTools window to inspect HTML/CSS, view `console.log()` outputs from `popup.js`, and set breakpoints in the **Sources** tab.

*Note:* If you click outside the popup, it will close, and the DevTools window for it will also close. To prevent this, you can undock the DevTools window or use the browser's "Emulate focused page" DevTools feature if available.

## 5. Debugging LLM Integration

The extension connects to local LLMs (via Ollama on port `11434`) and remote LLMs (Google Gemini).

- **Network Monitoring:** Use the Service Worker DevTools (**Network** tab) to monitor requests to `http://localhost:11434` or `https://generativelanguage.googleapis.com`. Check the request payloads and response bodies.
- **Ollama:** If using local models, ensure Ollama is running (`ollama serve`). You can test the endpoint manually using `curl` or Postman to ensure the local server is responding correctly:
  ```bash
  curl http://localhost:11434/api/generate -d '{"model": "llama3", "prompt": "test"}'
  ```
- **Gemini:** Verify your API keys are correctly set in the extension's storage/options if applicable, and look out for HTTP 400/403/429 errors in the Service Worker's Network tab.

## 6. Running Automated Tests

The project uses Jest for unit testing logic independent of Chrome APIs.

To run tests and debug logic (`selectors.js`, `text-cleaner.js`, `llm-providers.js`):
1. Ensure dependencies are installed: `npm install`
2. Run tests: `npm test`
3. To debug tests in an IDE (like VSCode or JetBrains), you can use the IDE's built-in Jest debugging configuration to step through test code.
