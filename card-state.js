// card-state.js — Per-tab card state management

// ─── Constants ───────────────────────────────────────────────

const REINJECT_DELAY_MS = 500;  // wait for DOM readiness before re-injecting

// ─── State ───────────────────────────────────────────────────

/** @type {Map<number, Array<{id: string, headline: string, url: string, status: string, text: string}>>} */
const tabCards = new Map();

/** Tabs with a re-injection in progress (prevents duplicate overlays). */
const reinjectingTabs = new Set();

// ─── CRUD ────────────────────────────────────────────────────

/**
 * Save or update a card's state for a given tab.
 * @param {number} tabId
 * @param {string} cardId
 * @param {object} data - Card properties to set / update
 */
function saveCard(tabId, cardId, data) {
    if (!tabCards.has(tabId)) tabCards.set(tabId, []);

    const cards = tabCards.get(tabId);
    const existing = cards.find(c => c.id === cardId);

    if (existing) {
        Object.assign(existing, data);
    } else {
        cards.push({ id: cardId, ...data });
    }
}

/**
 * Get all cards for a tab.
 * @param {number} tabId
 * @returns {Array|null}
 */
function getCards(tabId) {
    return tabCards.get(tabId) || null;
}

/**
 * Clear all cards for a tab.
 * @param {number} tabId
 */
function clearCards(tabId) {
    tabCards.delete(tabId);
}

// ─── Overlay re-injection ────────────────────────────────────

/**
 * Re-inject the overlay into a tab after page navigation.
 * Checks whether an overlay already exists, then rebuilds it from saved state.
 * @param {number} tabId
 */
async function reinjectOverlay(tabId) {
    const cards = getCards(tabId);
    if (!cards || cards.length === 0) return;
    if (reinjectingTabs.has(tabId)) return;
    reinjectingTabs.add(tabId);
    try {
        await doReinjectOverlay(tabId, cards);
    } finally {
        reinjectingTabs.delete(tabId);
    }
}

async function doReinjectOverlay(tabId, cards) {

    // Small delay to ensure the DOM is ready
    await new Promise(resolve => setTimeout(resolve, REINJECT_DELAY_MS));

    // Bail out if the overlay already exists
    try {
        const [{ result: exists }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => !!document.getElementById('cbr-overlay'),
        });
        if (exists) return;
    } catch (err) {
        console.log(`[CardState] Cannot access tab ${tabId}: ${err.message}`);
        return;
    }

    console.log(`[CardState] Re-injecting overlay for tab ${tabId} (${cards.length} cards)`);

    // Read timing preference
    const { showTiming } = await chrome.storage.local.get('showTiming');
    const shouldShowTiming = showTiming !== false;

    try {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });

        await chrome.scripting.executeScript({
            target: { tabId },
            func: (cardsData, displayTiming) => {
                // Build overlay shell
                const overlay = document.createElement('div');
                overlay.id = 'cbr-overlay';
                overlay.innerHTML =
                    '<div class="cbr-overlay-header">' +
                    '<span class="cbr-overlay-title">🔍 Spoiler</span>' +
                    '<button class="cbr-overlay-close" title="Close">✕</button>' +
                    '</div>' +
                    '<div class="cbr-cards"></div>';

                document.body.appendChild(overlay);

                overlay.querySelector('.cbr-overlay-close').addEventListener('click', (e) => {
                    e.stopPropagation();
                    overlay.remove();
                    chrome.runtime.sendMessage({ action: 'clearCards' });
                });
                overlay.addEventListener('click', (e) => e.stopPropagation());

                // Rebuild each card with DOM APIs: headline, URL and text come from the page / LLM.
                const cardsContainer = overlay.querySelector('.cbr-cards');

                for (const cardData of cardsData) {
                    const card = document.createElement('div');
                    card.className = 'cbr-card';
                    card.id = cardData.id;

                    const safeUrl = /^https?:\/\//i.test(cardData.url || '') ? cardData.url : '#';
                    const link = document.createElement('a');
                    link.className = 'cbr-card-headline';
                    link.href = safeUrl;
                    link.target = '_blank';
                    link.rel = 'noopener';
                    link.textContent = cardData.headline || '';
                    link.title = link.textContent;
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (safeUrl !== '#') window.open(safeUrl, '_blank', 'noopener');
                    });
                    card.appendChild(link);

                    if (cardData.status === 'done' || cardData.status === 'error') {
                        const p = document.createElement('p');
                        p.className = 'cbr-card-text';
                        if (cardData.status === 'error') p.style.color = '#ff6b6b';
                        p.textContent = cardData.text || '';
                        card.appendChild(p);

                        if (cardData.status === 'done' && displayTiming && cardData.elapsedMs > 0) {
                            const timingEl = document.createElement('span');
                            timingEl.className = 'cbr-card-timing';
                            timingEl.textContent = '⏱ ' + (cardData.elapsedMs / 1000).toFixed(1) + 's';
                            card.appendChild(timingEl);
                        }
                    } else {
                        const loading = document.createElement('div');
                        loading.className = 'cbr-card-loading';
                        const loader = document.createElement('div');
                        loader.className = 'cbr-loader';
                        const label = document.createElement('span');
                        label.textContent = cardData.text || 'Loading…';
                        loading.append(loader, label);
                        card.appendChild(loading);
                    }

                    cardsContainer.appendChild(card);
                }
            },
            args: [cards, shouldShowTiming],
        });

        console.log(`[CardState] Re-injection successful for tab ${tabId}`);
    } catch (err) {
        console.error('[CardState] Re-inject failed:', err.message);
    }
}

// ─── Exports ─────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tabCards, saveCard, getCards, clearCards, reinjectOverlay };
}
