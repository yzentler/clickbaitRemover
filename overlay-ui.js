// overlay-ui.js — Page-side result overlay (classic content script, injected on demand)
//
// The single owner of spoiler-card markup. The service worker sends state, this renders it:
//   { cbr: 'overlay', op: 'upsert',  card, showTiming }  create/replace one card
//   { cbr: 'overlay', op: 'stream',  id, text }          live-update a card's answer text
//   { cbr: 'overlay', op: 'restore', cards, showTiming } rebuild after navigation (idempotent)
//
// Rendered inside a closed-off Shadow DOM so host-page CSS can't leak in and ours can't leak out.
// All text is applied via textContent; URLs are restricted to http(s).

(() => {
    if (typeof window === 'undefined' || window.__cbrOverlayInstalled) return;
    window.__cbrOverlayInstalled = true;

    const HOST_ID = 'cbr-overlay-host';
    const ERROR_COLOR = '#ff6b6b';

    const OVERLAY_CSS = `
        :host { all: initial; }
        .overlay {
            position: fixed; top: 16px; right: 16px; width: 370px; max-height: 80vh;
            background: #1e1e2e; color: #e0e0e0; border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px;
            overflow: hidden; display: flex; flex-direction: column;
            animation: slide-in 0.25s ease-out;
        }
        @keyframes slide-in { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: none; } }
        @keyframes card-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: none; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 14px; background: #2a2a3d; border-bottom: 1px solid #3a3a50; flex-shrink: 0;
        }
        .title { font-weight: 600; font-size: 13px; color: #c0c0d0; }
        .close {
            background: none; border: none; color: #888; font-size: 16px; cursor: pointer;
            padding: 0 4px; line-height: 1; transition: color 0.15s;
        }
        .close:hover { color: ${ERROR_COLOR}; }
        .cards { overflow-y: auto; flex: 1; padding: 6px 0; }
        .card {
            padding: 10px 14px; border-bottom: 1px solid #2d2d44;
            animation: card-in 0.2s ease-out;
        }
        .card:last-child { border-bottom: none; }
        .headline {
            display: block; font-size: 12px; font-weight: 600; color: #8b8bf0; text-decoration: none;
            margin-bottom: 6px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; transition: color 0.15s;
        }
        .headline:hover { color: #ababff; text-decoration: underline; }
        .text { margin: 0; line-height: 1.6; font-size: 14px; color: #f0f0f0; white-space: pre-wrap; }
        .text.error { color: ${ERROR_COLOR}; }
        .loading { display: flex; align-items: center; gap: 8px; color: #999; font-size: 13px; }
        .loader {
            width: 14px; height: 14px; border: 2px solid #555; border-top-color: #7c6ef0;
            border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0;
        }
        .timing { display: block; font-size: 11px; color: #777; margin-top: 4px; text-align: left; direction: ltr; }
    `;

    /** @type {{ host: HTMLElement, shadow: ShadowRoot, cards: HTMLElement } | null} */
    let ui = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function safeHttpUrl(url) {
        return /^https?:\/\//i.test(url || '') ? url : null;
    }

    function closeOverlay() {
        ui?.host.remove();
        ui = null;
        Promise.resolve(chrome.runtime.sendMessage({ action: 'clearCards' })).catch(() => { });
    }

    function ensureUi() {
        if (ui && ui.host.isConnected) return ui;

        const host = el('div');
        host.id = HOST_ID;
        const shadow = host.attachShadow({ mode: 'closed' });

        const style = el('style', '', OVERLAY_CSS);
        const overlay = el('div', 'overlay');
        const header = el('div', 'header');
        const closeBtn = el('button', 'close', '✕');
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeOverlay();
        });
        header.append(el('span', 'title', '🔍 Spoiler'), closeBtn);

        const cards = el('div', 'cards');
        overlay.append(header, cards);
        overlay.addEventListener('click', (e) => e.stopPropagation());
        shadow.append(style, overlay);

        (document.body || document.documentElement).appendChild(host);
        ui = { host, shadow, cards };
        return ui;
    }

    function findCard(cards, id) {
        for (const node of cards.children) {
            if (node.dataset.cardId === id) return node;
        }
        return null;
    }

    function buildCard(card, showTiming) {
        const node = el('div', 'card');
        node.dataset.cardId = card.id;

        const href = safeHttpUrl(card.url);
        const headline = el('a', 'headline', card.headline || '');
        headline.dir = 'auto';   // Hebrew/Arabic render right-to-left, English left-to-right
        headline.title = card.headline || '';
        headline.target = '_blank';
        headline.rel = 'noopener';
        if (href) headline.href = href;
        headline.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (href) window.open(href, '_blank', 'noopener');
        });
        node.appendChild(headline);

        if (card.status === 'done' || card.status === 'error') {
            const answer = el('p', card.status === 'error' ? 'text error' : 'text', card.text || '');
            answer.dir = 'auto';
            node.appendChild(answer);
            if (card.status === 'done' && showTiming && card.elapsedMs > 0) {
                node.appendChild(el('span', 'timing', `⏱ ${(card.elapsedMs / 1000).toFixed(1)}s`));
            }
        } else {
            const loading = el('div', 'loading');
            const label = el('span', '', card.text || 'Loading…');
            label.dir = 'auto';
            loading.append(el('div', 'loader'), label);
            node.appendChild(loading);
        }
        return node;
    }

    function upsertCard(card, showTiming) {
        const { cards } = ensureUi();
        const fresh = buildCard(card, showTiming);
        const existing = findCard(cards, card.id);
        if (existing) {
            existing.replaceWith(fresh);
        } else {
            cards.appendChild(fresh);
            cards.scrollTop = cards.scrollHeight;
        }
    }

    function streamText(id, text) {
        if (!ui) return;
        const node = findCard(ui.cards, id);
        if (!node) return;
        node.querySelector('.loading')?.remove();
        let p = node.querySelector('.text');
        if (!p) {
            p = el('p', 'text');
            p.dir = 'auto';
            node.appendChild(p);
        }
        p.textContent = text;
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.cbr !== 'overlay') return;
        switch (message.op) {
            case 'upsert':
                upsertCard(message.card, message.showTiming);
                break;
            case 'stream':
                streamText(message.id, message.text);
                break;
            case 'restore':
                for (const card of message.cards || []) upsertCard(card, message.showTiming);
                break;
        }
    });

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { ensureUi, upsertCard, streamText, closeOverlay, HOST_ID };
    }
})();
