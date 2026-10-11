# Architecture

Spoiler is a Manifest V3 extension. The service worker is an ES module; the few scripts injected into pages are classic scripts (content scripts can't use `import`).

```
 right-click / Alt+V
        │
 background.js ── wiring only: registers listeners, delegates
        │
 spoiler-flow.js ── orchestration (link → card, page → card, viewport → inline badges)
   │        │            │               │
   │   extraction.js   llm-providers.js   cache.js
   │   fast fetch →    Ollama · Gemini    storage.local, keyed by
   │   hidden tab      Groq · Chrome AI   provider+model+URL, TTL, capped
   │
   ├── card-state.js ── per-tab card state in storage.session (survives worker restarts)
   └── ui-bridge.js  ── everything done *to a page*: messages + executeScript
                │
     ┌──────────┴───────────────┬─────────────────────┐
 overlay-ui.js           viewport-scanner.js     page-extract.js
 Shadow-DOM cards        finds headlines,        reads the live page
 (sole owner of card     renders inline badges   without modifying it
 markup)
```

## Principles

- **Page content is untrusted.** Headlines, article text and LLM output are only ever applied with `textContent`/`escapeHtml`; card links are restricted to `http(s)`.
- **The service worker holds no state in memory.** It can be killed any time; card state lives in `storage.session`, results in `storage.local`.
- **One renderer.** `overlay-ui.js` owns card markup. The worker sends state (`upsert` / `stream` / `restore`), never HTML.
- **Never modify the user's page.** Extraction hides noise elements temporarily and restores the exact original `style` attributes.
- **Failures are never cached.** `❌` answers and fallbacks are retried next time.

## Extraction order

1. `fetch()` the URL in the worker. Skip non-2xx and bot-challenge pages.
2. Structured article body (JSON-LD `articleBody`, `__NEXT_DATA__`).
3. DOM extraction with host-aware selectors (`selectors.js`).
4. If the page is client-rendered: open a hidden tab, poll until text appears, always close it.
5. Last resort: the metadata teaser (`og:description`).

## Tests

- `npm test` — Jest (Babel transforms the ES modules to CommonJS for tests only). Pure logic, orchestration with mocked I/O, and DOM behavior under jsdom.
- `cd e2e && npm install && npm run smoke` — loads the real extension in Chrome for Testing against a local fake news site and fake Ollama. Set `EXT_DIR` to test an unzipped release build.
