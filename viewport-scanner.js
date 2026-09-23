// viewport-scanner.js — Injected into the active tab to scan visible headlines and render inline spoilers

(() => {
    /**
     * Find all visible headline link candidates in the active viewport.
     */
    function scanViewportHeadlines() {
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        const links = Array.from(document.querySelectorAll('a[href]'));
        const visibleLinks = [];
        let counter = 0;

        for (const a of links) {
            // Skip links that already have an inline spoiler attached
            if (a.nextElementSibling?.classList?.contains('cbr-inline-spoiler')) {
                continue;
            }

            const rect = a.getBoundingClientRect();
            // Check if element is at least partially in the viewport
            const isVisible = (
                rect.top < viewportHeight &&
                rect.bottom > 0 &&
                rect.left < viewportWidth &&
                rect.right > 0 &&
                rect.width > 20 &&
                rect.height > 10
            );

            if (!isVisible) continue;

            const text = (a.innerText || a.textContent || '').trim();
            if (text.length < 15) continue;

            const id = `cbr-vp-${Date.now()}-${++counter}`;
            a.setAttribute('data-cbr-id', id);

            visibleLinks.push({
                id,
                url: a.href,
                text,
            });
        }

        return visibleLinks;
    }

    /**
     * Inject a loading badge directly after the target headline link.
     */
    function injectInlineLoadingBadge(id, headline) {
        const target = document.querySelector(`[data-cbr-id="${id}"]`);
        if (!target) return;

        // Check if badge already exists
        let badge = target.nextElementSibling;
        if (badge && badge.classList.contains('cbr-inline-spoiler')) {
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

        badge.querySelector('.cbr-inline-dismiss').addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            badge.remove();
        });

        // Insert directly after the link
        target.parentNode.insertBefore(badge, target.nextSibling);
    }

    /**
     * Update an inline badge with the final or streamed spoiler result.
     */
    function updateInlineBadgeResult(id, spoilerText, isError = false) {
        const badge = document.getElementById(`cbr-badge-${id}`);
        if (!badge) return;

        badge.classList.remove('cbr-loading');

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

        badge.querySelector('.cbr-inline-dismiss')?.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            badge.remove();
        });
    }

    // Expose helpers on window for chrome.scripting.executeScript calls
    window.__cbrScanViewport = scanViewportHeadlines;
    window.__cbrInjectInlineBadge = injectInlineLoadingBadge;
    window.__cbrUpdateInlineBadge = updateInlineBadgeResult;
})();
