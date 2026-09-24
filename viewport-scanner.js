// viewport-scanner.js — Injected into the active tab to scan visible headlines and render inline spoilers

(() => {
    /**
     * Compute a prominence score for a visible headline link candidate.
     */
    function computeProminenceScore(element, rect, viewportWidth) {
        let score = 0;

        // 1. Heading tag level bonus
        const heading = element.closest ? element.closest('h1, h2, h3, h4, [role="heading"]') : null;
        if (heading) {
            const tag = (heading.tagName || '').toLowerCase();
            if (tag === 'h1') score += 160;
            else if (tag === 'h2') score += 130;
            else if (tag === 'h3') score += 100;
            else if (tag === 'h4') score += 70;
            else score += 50;
        }

        // 2. Font size bonus
        try {
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
                const fontSize = parseFloat(window.getComputedStyle(element).fontSize) || 16;
                score += Math.round(fontSize * 2.5);
            }
        } catch (_e) {}

        // 3. Area / Dimensions bonus
        if (rect && typeof rect.width === 'number' && typeof rect.height === 'number') {
            const area = rect.width * rect.height;
            if (area > 20000) score += 60;
            else if (area > 8000) score += 40;
            else if (area > 3000) score += 20;

            // 4. Horizontal position: prefer items closer to the center over extreme sides
            if (viewportWidth > 0) {
                const distFromCenter = Math.abs((rect.left + rect.width / 2) - (viewportWidth / 2));
                const centerProximity = Math.max(0, 1 - (distFromCenter / (viewportWidth / 2)));
                score += Math.round(centerProximity * 40);
            }
        }

        // 5. Headline / Title class hints
        const classNames = `${element.className || ''} ${element.parentElement?.className || ''}`.toLowerCase();
        if (/headline|title|main|lead|top|article/.test(classNames)) {
            score += 30;
        }

        return score;
    }

    /**
     * Find all visible headline link candidates in the active viewport.
     */
    function scanViewportHeadlines() {
        const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || document.documentElement?.clientHeight || 800;
        const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || document.documentElement?.clientWidth || 1200;

        const links = Array.from(document.querySelectorAll('a[href]'));
        const visibleLinks = [];
        let counter = 0;

        for (const a of links) {
            // Skip links inside sidebars, gutters, navigation, footers, ads, or sponsored containers
            if (a.closest && a.closest('aside, nav, footer, [role="banner"], [role="navigation"], [class*="sidebar" i], [class*="gutter" i], [class*="rail" i], [class*="ad-banner" i], [class*="banner-ad" i], [class*="sponsored" i], [class*="outbrain" i], [class*="taboola" i], [id*="sidebar" i]')) {
                continue;
            }

            const headingParent = a.closest ? a.closest('h1, h2, h3, h4, [role="heading"]') : null;
            const checkTarget = headingParent || a;

            // Skip links that already have an inline spoiler attached
            if (checkTarget.nextElementSibling?.className?.includes('cbr-inline-spoiler') ||
                a.nextElementSibling?.className?.includes('cbr-inline-spoiler')) {
                continue;
            }

            const rect = a.getBoundingClientRect ? a.getBoundingClientRect() : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };

            // Element must be visible in viewport
            const isVisible = (
                rect.top < viewportHeight &&
                rect.bottom > 0 &&
                rect.left < viewportWidth &&
                rect.right > 0 &&
                rect.width >= 100 &&
                rect.height >= 12
            );

            if (!isVisible) continue;

            // Filter out edge gutters (side rails sitting on screen margins)
            if (rect.left < 35 || rect.right > viewportWidth - 35) {
                continue;
            }

            // Filter out elements with ultra-narrow parent containers
            let parentWidth = rect.width;
            if (a.parentElement && typeof a.parentElement.getBoundingClientRect === 'function') {
                const pRect = a.parentElement.getBoundingClientRect();
                if (pRect && typeof pRect.width === 'number' && pRect.width > 0) {
                    parentWidth = pRect.width;
                }
            }
            if (parentWidth < 120) {
                continue;
            }

            const text = (a.innerText || a.textContent || '').trim();
            if (text.length < 15) continue;

            const score = computeProminenceScore(a, rect, viewportWidth);
            const id = `cbr-vp-${Date.now()}-${++counter}`;
            a.setAttribute('data-cbr-id', id);

            visibleLinks.push({
                id,
                url: a.href,
                text,
                score,
                width: rect.width,
                containerWidth: parentWidth,
            });
        }

        // Sort candidates by prominence score descending (main articles first)
        visibleLinks.sort((a, b) => b.score - a.score);

        return visibleLinks;
    }

    /**
     * Inject a loading badge directly after the target headline link or its heading container.
     */
    function injectInlineLoadingBadge(id, headline) {
        const target = document.querySelector(`[data-cbr-id="${id}"]`);
        if (!target) return;

        // If link is inside an h1-h4, insert after the heading block to preserve layout
        let insertAfterEl = target;
        const headingParent = target.closest ? target.closest('h1, h2, h3, h4, [role="heading"]') : null;
        if (headingParent && headingParent.parentNode) {
            insertAfterEl = headingParent;
        }

        // Check if badge already exists
        let badge = insertAfterEl.nextElementSibling;
        if (badge && badge.className && badge.className.includes('cbr-inline-spoiler')) {
            return;
        }

        badge = document.createElement('div');
        badge.id = `cbr-badge-${id}`;
        badge.className = 'cbr-inline-spoiler cbr-loading';
        badge.innerHTML = `
            <span class="cbr-inline-spinner"></span>
            <span class="cbr-inline-content">⏳ Analyzing spoiler…</span>
            <button class="cbr-inline-dismiss" title="Dismiss">×</button>
        `;

        const dismissBtn = badge.querySelector('.cbr-inline-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', (e) => {
                if (e.stopPropagation) e.stopPropagation();
                if (e.preventDefault) e.preventDefault();
                badge.remove();
            });
        }

        // Insert directly after the target or heading container
        if (insertAfterEl.parentNode) {
            insertAfterEl.parentNode.insertBefore(badge, insertAfterEl.nextSibling);
        }

        // Ensure parent card containers don't clamp height or clip vertically
        let ancestor = insertAfterEl.parentElement;
        for (let depth = 0; depth < 3 && ancestor && ancestor !== document.body; depth++) {
            const computed = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(ancestor) : null;
            if (computed) {
                if (computed.overflow === 'hidden' || computed.overflowY === 'hidden') {
                    if (ancestor.style && typeof ancestor.style.setProperty === 'function') {
                        ancestor.style.setProperty('overflow', 'visible', 'important');
                    }
                }
                if (computed.maxHeight && computed.maxHeight !== 'none') {
                    if (ancestor.style && typeof ancestor.style.setProperty === 'function') {
                        ancestor.style.setProperty('max-height', 'none', 'important');
                    }
                }
            }
            ancestor = ancestor.parentElement;
        }
    }

    /**
     * Update an inline badge with the final or streamed spoiler result.
     */
    function updateInlineBadgeResult(id, spoilerText, isError = false) {
        const badge = document.getElementById(`cbr-badge-${id}`);
        if (!badge) return;

        badge.className = badge.className.replace(/\bcbr-loading\b/g, '').trim();

        if (isError) {
            badge.innerHTML = `
                <span class="cbr-inline-icon">⚠️</span>
                <span class="cbr-inline-content">${spoilerText || 'Could not reveal spoiler'}</span>
                <button class="cbr-inline-dismiss" title="Dismiss">×</button>
            `;
        } else {
            // Parse into question and answer if formatted with ❓ / 💡
            let question = '';
            let answer = spoilerText;

            const qMatch = spoilerText.match(/❓\s*([^💡\n]+)/);
            const aMatch = spoilerText.match(/💡\s*([\s\S]+)/);

            if (qMatch && aMatch) {
                question = qMatch[1].trim();
                answer = aMatch[1].trim();
            } else if (aMatch) {
                answer = aMatch[1].trim();
            }

            badge.innerHTML = `
                <span class="cbr-inline-icon">💡</span>
                <div class="cbr-inline-content">
                    ${question ? `<strong class="cbr-inline-question">${question}</strong>` : ''}
                    <span class="cbr-inline-answer">${answer}</span>
                </div>
                <button class="cbr-inline-dismiss" title="Dismiss">×</button>
            `;
        }

        const dismissBtn = badge.querySelector('.cbr-inline-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', (e) => {
                if (e.stopPropagation) e.stopPropagation();
                if (e.preventDefault) e.preventDefault();
                badge.remove();
            });
        }
    }

    // Expose helpers on window for chrome.scripting.executeScript calls
    if (typeof window !== 'undefined') {
        window.__cbrScanViewport = scanViewportHeadlines;
        window.__cbrInjectInlineBadge = injectInlineLoadingBadge;
        window.__cbrUpdateInlineBadge = updateInlineBadgeResult;
        window.__cbrComputeProminence = computeProminenceScore;
    }

    // Expose for Node/Jest unit testing
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            computeProminenceScore,
            scanViewportHeadlines,
            injectInlineLoadingBadge,
            updateInlineBadgeResult,
        };
    }
})();
