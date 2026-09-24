// tests/viewport-scanner.test.js

class MockElement {
    constructor(tagName) {
        this.tagName = (tagName || 'DIV').toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.parentNode = null;
        this.attributes = {};
        this.className = '';
        this.textContent = '';
        this.innerText = '';
        this.innerHTML = '';
        this.href = '';
        this.id = '';
        this.style = { setProperty: (k, v) => { this.style[k] = v; } };
        this._rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
        this._listeners = {};
    }

    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    
    appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        child.parentNode = this;
        return child;
    }

    insertBefore(newChild, refChild) {
        const idx = this.children.indexOf(refChild);
        if (idx === -1) {
            this.children.push(newChild);
        } else {
            this.children.splice(idx, 0, newChild);
        }
        newChild.parentElement = this;
        newChild.parentNode = this;
        return newChild;
    }

    remove() {
        if (this.parentElement) {
            const idx = this.parentElement.children.indexOf(this);
            if (idx !== -1) this.parentElement.children.splice(idx, 1);
        }
    }

    addEventListener(event, fn) {
        this._listeners[event] = this._listeners[event] || [];
        this._listeners[event].push(fn);
    }

    get nextElementSibling() {
        if (!this.parentElement) return null;
        const siblings = this.parentElement.children;
        const idx = siblings.indexOf(this);
        return idx !== -1 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
    }

    get nextSibling() {
        return this.nextElementSibling;
    }

    getBoundingClientRect() {
        return this._rect;
    }

    setBoundingClientRect(rect) {
        this._rect = { ...this._rect, ...rect };
    }

    closest(selector) {
        let curr = this;
        while (curr) {
            const tag = (curr.tagName || '').toLowerCase();
            const cls = (curr.className || '').toLowerCase();
            const id = (curr.id || '').toLowerCase();
            const role = (curr.getAttribute('role') || '').toLowerCase();

            if (['aside', 'nav', 'footer', 'h1', 'h2', 'h3', 'h4'].includes(tag) && selector.toLowerCase().includes(tag)) {
                return curr;
            }
            if (selector.includes('sidebar') && (cls.includes('sidebar') || id.includes('sidebar'))) {
                return curr;
            }
            if (selector.includes('gutter') && cls.includes('gutter')) {
                return curr;
            }
            if (selector.includes('banner') && (cls.includes('banner') || role === 'banner')) {
                return curr;
            }
            if (selector.includes('heading') && role === 'heading') {
                return curr;
            }
            curr = curr.parentElement;
        }
        return null;
    }

    querySelector(sel) {
        for (const child of this.children) {
            if (sel.startsWith('.') && child.className.includes(sel.slice(1))) return child;
            if (sel.startsWith('#') && child.id === sel.slice(1)) return child;
            const found = child.querySelector(sel);
            if (found) return found;
        }
        return null;
    }

    querySelectorAll(sel) {
        const results = [];
        const traverse = (node) => {
            for (const child of node.children) {
                if (sel === 'a[href]' && child.tagName === 'A' && child.href) {
                    results.push(child);
                }
                traverse(child);
            }
        };
        traverse(this);
        return results;
    }
}

// Global environment setup
global.window = {
    innerHeight: 800,
    innerWidth: 1200,
    getComputedStyle: (el) => ({
        fontSize: '16px',
        overflow: el?.style?.overflow || 'visible',
        overflowY: el?.style?.overflowY || 'visible',
        maxHeight: el?.style?.maxHeight || 'none',
    }),
};

const mockBody = new MockElement('BODY');
global.document = {
    body: mockBody,
    documentElement: { clientHeight: 800, clientWidth: 1200 },
    createElement: (tag) => new MockElement(tag),
    querySelector: (sel) => {
        if (sel.includes('[data-cbr-id=')) {
            const id = sel.match(/\[data-cbr-id="([^"]+)"\]/)?.[1];
            const findById = (node) => {
                for (const c of node.children) {
                    if (c.getAttribute('data-cbr-id') === id) return c;
                    const f = findById(c);
                    if (f) return f;
                }
                return null;
            };
            return findById(mockBody);
        }
        return mockBody.querySelector(sel);
    },
    getElementById: (id) => {
        const find = (node) => {
            for (const c of node.children) {
                if (c.id === id) return c;
                const f = find(c);
                if (f) return f;
            }
            return null;
        };
        return find(mockBody);
    },
    querySelectorAll: (sel) => mockBody.querySelectorAll(sel),
};

const {
    computeProminenceScore,
    scanViewportHeadlines,
    injectInlineLoadingBadge,
    updateInlineBadgeResult,
} = require('../viewport-scanner');

describe('viewport-scanner', () => {
    beforeEach(() => {
        mockBody.children = [];
        window.innerHeight = 800;
        window.innerWidth = 1200;
    });

    describe('computeProminenceScore', () => {
        test('awards higher score to h1 and h2 over plain links', () => {
            const h1 = new MockElement('H1');
            const linkH1 = new MockElement('A');
            h1.appendChild(linkH1);

            const p = new MockElement('P');
            const linkPlain = new MockElement('A');
            p.appendChild(linkPlain);

            const rectH1 = { left: 400, right: 800, width: 400, height: 50 };
            const rectPlain = { left: 400, right: 600, width: 200, height: 20 };

            const scoreH1 = computeProminenceScore(linkH1, rectH1, 1200);
            const scorePlain = computeProminenceScore(linkPlain, rectPlain, 1200);

            expect(scoreH1).toBeGreaterThan(scorePlain);
        });

        test('awards bonus for headline/title class names', () => {
            const linkNormal = new MockElement('A');
            const linkHeadline = new MockElement('A');
            linkHeadline.className = 'main-article-title';

            const rect = { left: 500, right: 700, width: 200, height: 30 };
            const scoreNormal = computeProminenceScore(linkNormal, rect, 1200);
            const scoreHeadline = computeProminenceScore(linkHeadline, rect, 1200);

            expect(scoreHeadline).toBeGreaterThan(scoreNormal);
        });
    });

    describe('scanViewportHeadlines', () => {
        test('skips links in sidebars, gutters, and ultra-narrow containers', () => {
            // Main article
            const mainContainer = new MockElement('DIV');
            const h2 = new MockElement('H2');
            const mainLink = new MockElement('A');
            mainLink.href = 'https://sports.walla.co.il/item/11111';
            mainLink.textContent = 'כותרת ראשית ענקית על הפועל תל אביב';
            mainLink.innerText = mainLink.textContent;
            mainLink.setBoundingClientRect({
                top: 100, bottom: 150, left: 100, right: 600, width: 500, height: 50
            });
            h2.appendChild(mainLink);
            mainContainer.appendChild(h2);
            mockBody.appendChild(mainContainer);

            // Sidebar article (narrow vertical monstrosity risk)
            const aside = new MockElement('ASIDE');
            const sideLink = new MockElement('A');
            sideLink.href = 'https://sports.walla.co.il/item/22222';
            sideLink.textContent = 'קישור בסרגל הצדדי הצר שיש לסנן תמיד';
            sideLink.innerText = sideLink.textContent;
            sideLink.setBoundingClientRect({
                top: 100, bottom: 200, left: 1180, right: 1200, width: 20, height: 100
            });
            aside.appendChild(sideLink);
            mockBody.appendChild(aside);

            const results = scanViewportHeadlines();
            expect(results).toHaveLength(1);
            expect(results[0].url).toBe('https://sports.walla.co.il/item/11111');
        });

        test('prioritizes main headlines over tiny ticker links by score', () => {
            // Ticker link
            const ticker = new MockElement('A');
            ticker.href = 'https://sports.walla.co.il/item/ticker';
            ticker.textContent = 'מבזק קטן וקצר בראש הדף שמופיע ראשון';
            ticker.innerText = ticker.textContent;
            ticker.setBoundingClientRect({
                top: 10, bottom: 30, left: 100, right: 300, width: 200, height: 20
            });
            mockBody.appendChild(ticker);

            // Big H1 link
            const h1 = new MockElement('H1');
            const bigLink = new MockElement('A');
            bigLink.href = 'https://sports.walla.co.il/item/big-story';
            bigLink.textContent = 'סיפור ענק בכותרת ראשית בולטת מאוד';
            bigLink.innerText = bigLink.textContent;
            bigLink.setBoundingClientRect({
                top: 200, bottom: 300, left: 200, right: 900, width: 700, height: 100
            });
            h1.appendChild(bigLink);
            mockBody.appendChild(h1);

            const results = scanViewportHeadlines();
            expect(results).toHaveLength(2);
            // Big headline should be ranked #1
            expect(results[0].url).toBe('https://sports.walla.co.il/item/big-story');
            expect(results[1].url).toBe('https://sports.walla.co.il/item/ticker');
        });
    });

    describe('injectInlineLoadingBadge', () => {
        test('inserts badge after the heading container if link is inside h2', () => {
            const h2 = new MockElement('H2');
            const link = new MockElement('A');
            link.setAttribute('data-cbr-id', 'test-1');
            link.textContent = 'כותרת לבדיקת הזרקה';
            h2.appendChild(link);
            mockBody.appendChild(h2);

            injectInlineLoadingBadge('test-1', 'כותרת לבדיקת הזרקה');

            // Badge should be sibling of h2, not inside h2
            expect(h2.nextElementSibling).not.toBeNull();
            expect(h2.nextElementSibling.id).toBe('cbr-badge-test-1');
        });

        test('unclamps ancestor card overflow and max-height to prevent vertical clipping', () => {
            const card = new MockElement('DIV');
            card.style = { overflow: 'hidden', maxHeight: '100px', setProperty: jest.fn() };
            const link = new MockElement('A');
            link.setAttribute('data-cbr-id', 'test-clamp');
            card.appendChild(link);
            mockBody.appendChild(card);

            injectInlineLoadingBadge('test-clamp', 'כותרת');
            expect(card.style.setProperty).toHaveBeenCalledWith('overflow', 'visible', 'important');
            expect(card.style.setProperty).toHaveBeenCalledWith('max-height', 'none', 'important');
        });
    });

    describe('updateInlineBadgeResult', () => {
        test('updates badge content with answer and question', () => {
            const link = new MockElement('A');
            link.setAttribute('data-cbr-id', 'test-2');
            mockBody.appendChild(link);

            injectInlineLoadingBadge('test-2', 'כותרת');
            updateInlineBadgeResult('test-2', '❓ מה קרה? 💡 איטודיס הודיע על התפטרות');

            const badge = document.getElementById('cbr-badge-test-2');
            expect(badge.className.includes('cbr-loading')).toBe(false);
            expect(badge.innerHTML).toContain('מה קרה?');
            expect(badge.innerHTML).toContain('איטודיס הודיע על התפטרות');
        });

        test('handles error state properly', () => {
            const link = new MockElement('A');
            link.setAttribute('data-cbr-id', 'test-3');
            mockBody.appendChild(link);

            injectInlineLoadingBadge('test-3', 'כותרת');
            updateInlineBadgeResult('test-3', 'Extraction failed', true);

            const badge = document.getElementById('cbr-badge-test-3');
            expect(badge.className.includes('cbr-loading')).toBe(false);
            expect(badge.innerHTML).toContain('Extraction failed');
            expect(badge.innerHTML).toContain('⚠️');
        });
    });

    describe('inline-spoiler.css responsive constraints', () => {
        const fs = require('fs');
        const path = require('path');
        const cssContent = fs.readFileSync(path.join(__dirname, '../inline-spoiler.css'), 'utf-8');

        test('constrains badge width to parent container without max-content or rigid min-width', () => {
            expect(cssContent).not.toMatch(/width:\s*max-content/i);
            expect(cssContent).not.toMatch(/min-width:\s*260px/i);
            expect(cssContent).toMatch(/width:\s*100%/i);
            expect(cssContent).toMatch(/max-width:\s*100%/i);
        });

        test('allows flex content to wrap with min-width: 0', () => {
            expect(cssContent).toMatch(/\.cbr-inline-content\s*\{[^}]*min-width:\s*0/s);
            expect(cssContent).toMatch(/\.cbr-inline-content\s*\{[^}]*word-break:\s*break-word/s);
        });

        test('uses margin-inline-start for dismiss button alignment across RTL and LTR', () => {
            expect(cssContent).toMatch(/\.cbr-inline-dismiss\s*\{[^}]*margin-inline-start:\s*auto/s);
        });

        test('prevents flexbox vertical squashing with flex-shrink: 0 and overflow: visible', () => {
            expect(cssContent).toMatch(/\.cbr-inline-spoiler\s*\{[^}]*flex-shrink:\s*0/s);
            expect(cssContent).toMatch(/\.cbr-inline-spoiler\s*\{[^}]*overflow:\s*visible/s);
        });

        test('uses compact font-size for dense multi-column grids', () => {
            expect(cssContent).toMatch(/\.cbr-inline-spoiler\s*\{[^}]*font-size:\s*12px/s);
            expect(cssContent).toMatch(/\.cbr-inline-question\s*\{[^}]*font-size:\s*11\.5px/s);
        });
    });
});
