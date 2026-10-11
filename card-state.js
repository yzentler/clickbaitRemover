// card-state.js — Per-tab card state, persisted in chrome.storage.session
//
// The MV3 service worker is killed after ~30s idle, so card state can't live in module memory.
// storage.session survives worker restarts (but not browser restarts, which is what we want).

import { STALE_LOADING_CARD_MS } from './config.js';

const REINJECT_DELAY_MS = 500;  // wait for DOM readiness before re-injecting

const keyFor = (tabId) => `cbr_cards_${tabId}`;

// ─── Storage adapter (falls back to memory where storage.session is unavailable) ───

const memoryStore = new Map();

function sessionArea() {
    return (typeof chrome !== 'undefined' && chrome.storage?.session) || null;
}

async function readCards(tabId) {
    const area = sessionArea();
    if (!area) return memoryStore.get(tabId) || [];
    const key = keyFor(tabId);
    return (await area.get(key))[key] || [];
}

async function writeCards(tabId, cards) {
    const area = sessionArea();
    if (!area) {
        memoryStore.set(tabId, cards);
        return;
    }
    await area.set({ [keyFor(tabId)]: cards });
}

// Read-modify-write is serialized per tab so concurrent updates can't clobber each other.
const queues = new Map();

function serialized(tabId, task) {
    const previous = queues.get(tabId) || Promise.resolve();
    const run = previous.then(task, task);
    queues.set(tabId, run.catch(() => { }));
    return run;
}

// ─── CRUD ────────────────────────────────────────────────────

/** Unique across service-worker restarts (a counter would restart at 1 and collide). */
export function newCardId() {
    return `cbr-card-${crypto.randomUUID()}`;
}

/**
 * Create or merge a card's state for a tab.
 * @returns {Promise<object>} The merged card
 */
export function saveCard(tabId, cardId, data) {
    return serialized(tabId, async () => {
        const cards = await readCards(tabId);
        const updatedAt = Date.now();
        const index = cards.findIndex(c => c.id === cardId);
        let merged;
        if (index >= 0) {
            merged = { ...cards[index], ...data, updatedAt };
            cards[index] = merged;
        } else {
            merged = { id: cardId, ...data, updatedAt };
            cards.push(merged);
        }
        await writeCards(tabId, cards);
        return merged;
    });
}

/** @returns {Promise<Array|null>} */
export async function getCards(tabId) {
    const cards = await readCards(tabId);
    return cards.length > 0 ? cards : null;
}

export function clearCards(tabId) {
    return serialized(tabId, async () => {
        const area = sessionArea();
        if (area) await area.remove(keyFor(tabId));
        else memoryStore.delete(tabId);
    });
}

/** A card still "loading" long after its last update lost its worker mid-flight. */
export function markInterruptedCards(cards, now = Date.now()) {
    return cards.map(card =>
        card.status === 'loading' && now - (card.updatedAt || 0) > STALE_LOADING_CARD_MS
            ? { ...card, status: 'error', text: 'Interrupted — right-click the link to try again.' }
            : card);
}

// ─── Overlay re-injection ────────────────────────────────────

const reinjecting = new Set();

/**
 * Rebuild the overlay in a tab after page navigation.
 * @param {number} tabId
 * @param {(tabId: number, cards: object[]) => Promise<void>} restore - UI hook (ui-bridge.restoreCards)
 */
export async function reinjectOverlay(tabId, restore) {
    if (reinjecting.has(tabId)) return;
    reinjecting.add(tabId);   // claim the slot before any await, or concurrent callers all pass the check
    try {
        const stored = await getCards(tabId);
        if (!stored) return;

        await new Promise(resolve => setTimeout(resolve, REINJECT_DELAY_MS));
        await restore(tabId, markInterruptedCards(stored));
    } catch (err) {
        console.log(`[CardState] Re-inject failed for tab ${tabId}: ${err.message}`);
    } finally {
        reinjecting.delete(tabId);
    }
}
