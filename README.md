# Spoiler

A Chrome extension that reveals the answer hidden behind clickbait headlines. Right-click a headline (or press **Alt+V**) and get the question the headline teases, plus the answer from the article, in one line. Works with Hebrew, English and Arabic articles.

## Features

- **Right-click a link** → "🔍 Reveal the Spoiler" shows a card with the question and the answer.
- **Alt+V** (or right-click the page → "Reveal Visible Spoilers") scans the headlines on screen and shows inline spoilers under each one. Articles are processed three per LLM request to stay within rate limits.
- **Streaming** results, per-URL caching (7 days), and an optional response-time display.
- **Pick your LLM:** Ollama (local), Chrome Built-in AI (on-device), Google Gemini (cloud) or Groq (cloud).

## Privacy: what leaves your machine

Spoiler works by fetching the article behind a headline and sending its text to an LLM. Where that text goes depends on the provider you choose:

| Provider | Where the article text is sent |
|---|---|
| Ollama (default) | Your own machine (`localhost:11434`). Nothing leaves it. |
| Chrome Built-in AI | Processed on-device by Chrome. Nothing leaves your machine. |
| Gemini | Google (`generativelanguage.googleapis.com`) |
| Groq | Groq (`api.groq.com`) |

Things worth knowing:

- With Gemini or Groq, the headline and up to a few thousand characters of each article are sent to that provider. The popup shows a warning when a cloud provider is selected.
- The extension fetches the article URL itself, from your browser. If the page needs a login, it is fetched with your session, and (with a cloud provider) that content is sent to the LLM. Only use a cloud provider on pages you're comfortable sharing.
- If the article is rendered by JavaScript, the extension briefly opens the link in a hidden background tab to read it.
- API keys and settings are stored in the extension's local storage (`chrome.storage.local`) on your device. The extension has no server of its own and no analytics.
- Results are cached locally per URL for 7 days.

## Permissions

| Permission | Why |
|---|---|
| `<all_urls>` (host) | Fetch article pages from any news site and talk to your LLM endpoint. |
| `scripting` | Inject the result cards and inline spoilers into the page. |
| `storage` | Save settings and the result cache. |
| `contextMenus` | The right-click menu entries. |
| `webNavigation` | Restore your spoiler cards after in-tab navigation. |

## Prerequisites

1. **Google Chrome** or another Chromium-based browser.
2. One LLM provider:
   - **Ollama** (local, free): install from [ollama.com](https://ollama.com) and pull a model, e.g. `ollama pull qwen2.5:3b`.
   - **Gemini** or **Groq**: an API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey), [console.groq.com/keys](https://console.groq.com/keys)).
   - **Chrome Built-in AI**: a Chrome version with Gemini Nano available. This provider is experimental: whether the Prompt API is exposed to extension service workers depends on the Chrome version, so if the popup reports it unavailable, pick another provider.

> [!IMPORTANT]
> **One-time setup for Ollama on macOS.** So the extension can talk to Ollama without a terminal open, run once:
>
> ```bash
> launchctl setenv OLLAMA_ORIGINS "*"
> ```
>
> Then quit and reopen the Ollama app. You may need to re-run this after a reboot.

## Installation

1. Clone or download this repository.
   ```bash
   git clone https://github.com/yzentler/clickbaitRemover.git
   ```
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

## Configuration

Click the extension icon, pick a provider and model, then **Save**. Use **Test Connection** to check it works.

## Usage

- **Single headline:** right-click a link → **🔍 Reveal the Spoiler**.
- **Everything on screen:** press **Alt+V**, or right-click the page → **🔍 Reveal Visible Spoilers (Screen)**. Dismiss any inline spoiler with its ×.

## Troubleshooting

- **"Forbidden" / network error with Ollama:** did you run the `launchctl` command above and restart Ollama?
- **Nothing happens or an error card appears:** open `chrome://extensions` → Spoiler → **Inspect views: service worker** and check the console. See [DEBUGGING.md](DEBUGGING.md).
- **"Could not extract article content":** the site may block automated fetches or need a login.

## Development

```bash
npm install
npm test
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it's put together and [DEBUGGING.md](DEBUGGING.md) for loading and debugging the extension.

## License

[MIT](LICENSE)
