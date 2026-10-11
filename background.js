// background.js — Service worker entry point: registers listeners and delegates to the flow modules.

import { handleLinkClick, handlePageClick, handleRevealVisibleSpoilers } from './spoiler-flow.js';
import { reinjectOverlay, clearCards } from './card-state.js';
import { restoreCards } from './ui-bridge.js';
import { pruneCache } from './cache.js';

const CONTEXT_MENU_ID = 'summarizePage';
const REVEAL_MENU_ID = 'revealVisibleSpoilers';

// ─── Context menus ───────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: CONTEXT_MENU_ID,
        title: '🔍 Reveal the Spoiler',
        contexts: ['link', 'selection'],
    });
    chrome.contextMenus.create({
        id: REVEAL_MENU_ID,
        title: '🔍 Reveal Visible Spoilers (Screen)',
        contexts: ['page'],
    });
    pruneCache();
});

chrome.runtime.onStartup.addListener(() => { pruneCache(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;

    if (info.menuItemId === REVEAL_MENU_ID) return handleRevealVisibleSpoilers(tab);
    if (info.menuItemId !== CONTEXT_MENU_ID) return;

    return info.linkUrl
        ? handleLinkClick(tab, info.linkUrl)
        : handlePageClick(tab, info.selectionText);
});

// ─── Keyboard command ────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'reveal-visible-spoilers') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await handleRevealVisibleSpoilers(tab);
});

// ─── Tab lifecycle ───────────────────────────────────────────

// Re-show spoiler cards after a navigation completes in the tab
chrome.webNavigation.onCompleted.addListener(({ frameId, url, tabId }) => {
    if (frameId !== 0 || !url.startsWith('http')) return;
    reinjectOverlay(tabId, restoreCards);
});

chrome.tabs.onRemoved.addListener((tabId) => clearCards(tabId));

// ─── Messages from page scripts ──────────────────────────────

chrome.runtime.onMessage.addListener((request, sender) => {
    if (request?.action === 'clearCards' && sender.tab) {
        clearCards(sender.tab.id);
    }
});
