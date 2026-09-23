// card-state.js — Per-tab card state management

// ─── Constants ───────────────────────────────────────────────

const REINJECT_DELAY_MS = 500;  // wait for DOM readiness before re-injecting

// ─── State ───────────────────────────────────────────────────

/** @type {Map<number, Array<{id: string, headline: string, url: string, status: string, text: string}>>} */
const tabCards = new Map();

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

                // Rebuild each card
                const cardsContainer = overlay.querySelector('.cbr-cards');

                for (const cardData of cardsData) {
                    const card = document.createElement('div');
                    card.className = 'cbr-card';
                    card.id = cardData.id;

                    // Safely escape headline text
                    const safeHeadline = document.createElement('span');
                    safeHeadline.textContent = cardData.headline || '';
                    const headlineText = safeHeadline.textContent;

                    const linkHtml =
                        '<a class="cbr-card-headline" href="' + cardData.url +
                        '" target="_blank" rel="noopener" title="' + headlineText +
                        '">' + headlineText + '</a>';

                    if (cardData.status === 'done') {
                        const safeText = document.createElement('span');
                        safeText.textContent = cardData.text;
                        card.innerHTML = linkHtml + '<p class="cbr-card-text">' + safeText.innerHTML + '</p>';
                        if (displayTiming && cardData.elapsedMs > 0) {
                            const timingEl = document.createElement('span');
                            timingEl.className = 'cbr-card-timing';
                            timingEl.textContent = '⏱ ' + (cardData.elapsedMs / 1000).toFixed(1) + 's';
                            card.appendChild(timingEl);
                        }
                    } else if (cardData.status === 'error') {
                        const safeText = document.createElement('span');
                        safeText.textContent = cardData.text;
                        card.innerHTML = linkHtml + '<p class="cbr-card-text" style="color:#ff6b6b">' + safeText.innerHTML + '</p>';
                    } else {
                        card.innerHTML = linkHtml +
                            '<div class="cbr-card-loading">' +
                            '<div class="cbr-loader"></div>' +
                            '<span>' + (cardData.text || 'Loading…') + '</span>' +
                            '</div>';
                    }

                    card.querySelector('.cbr-card-headline').addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(cardData.url, '_blank');
                    });

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
