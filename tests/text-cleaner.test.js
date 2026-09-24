const { cleanArticleText, budgetArticleText, filterSpoilerResponse } = require('../text-cleaner');

describe('cleanArticleText', () => {
    test('returns empty string for falsy input', () => {
        expect(cleanArticleText(null)).toBe('');
        expect(cleanArticleText(undefined)).toBe('');
        expect(cleanArticleText('')).toBe('');
    });

    test('removes standalone URLs', () => {
        const input = 'This is article text.\nhttps://example.com/share\nMore article text here.';
        const result = cleanArticleText(input);
        expect(result).toContain('This is article text.');
        expect(result).toContain('More article text here.');
        expect(result).not.toContain('https://example.com');
    });

    test('removes share/social lines (Hebrew)', () => {
        const input = 'Article paragraph one.\nשתף ב וואצאפ\nשתף ב פייסבוק\nArticle paragraph two.';
        const result = cleanArticleText(input);
        expect(result).not.toMatch(/שתף ב/);
        expect(result).toContain('Article paragraph one.');
        expect(result).toContain('Article paragraph two.');
    });

    test('removes share/social lines (English)', () => {
        const input = 'Article text here.\nShare on Facebook\nTweet this article\nMore content.';
        const result = cleanArticleText(input);
        expect(result).not.toMatch(/Share on/i);
        expect(result).not.toMatch(/Tweet/i);
    });

    test('removes CSS class references', () => {
        const input = 'Article content.\n.css-1abc23{white-space:nowrap;}\nMore content here.';
        const result = cleanArticleText(input);
        expect(result).not.toContain('.css-');
        expect(result).toContain('Article content.');
    });

    test('removes very short lines (< 4 chars)', () => {
        const input = 'Full article paragraph.\n·\n—\nAnother paragraph.';
        const result = cleanArticleText(input);
        expect(result).not.toContain('·');
        expect(result).toContain('Full article paragraph.');
        expect(result).toContain('Another paragraph.');
    });

    test('removes common UI elements (Hebrew)', () => {
        const input = 'Article body text.\nתגובות\nעוד באותו נושא\nכתבות נוספות\nמומלצים עבורך\nMore article body.';
        const result = cleanArticleText(input);
        expect(result).not.toMatch(/תגובות/);
        expect(result).not.toMatch(/עוד באותו נושא/);
        expect(result).not.toMatch(/כתבות נוספות/);
        expect(result).not.toMatch(/מומלצים עבורך/);
    });

    test('removes common UI elements (English)', () => {
        const input = 'Article content.\nComments section below\nMore article text.';
        const result = cleanArticleText(input);
        expect(result).not.toMatch(/^Comments/m);
    });

    test('deduplicates identical lines', () => {
        const input = 'First paragraph.\nDuplicated line.\nDuplicated line.\nDuplicated line.\nLast paragraph.';
        const result = cleanArticleText(input);
        // Should have exactly one "Duplicated line."
        const matches = result.match(/Duplicated line\./g);
        expect(matches).toHaveLength(1);
    });

    test('collapses multiple blank lines', () => {
        const input = 'Para one.\n\n\n\n\nPara two.';
        const result = cleanArticleText(input);
        expect(result).not.toMatch(/\n{3,}/);
    });

    test('collapses multiple spaces and tabs', () => {
        const input = 'Text  with   many    spaces\tand\ttabs.';
        const result = cleanArticleText(input);
        expect(result).toBe('Text with many spaces and tabs.');
    });

    test('caps output at 6000 characters', () => {
        const longLine = 'A'.repeat(100);
        // 100 lines of 100 chars = 10,000 chars + newlines
        const input = Array(100).fill(longLine).join('\n');
        const result = cleanArticleText(input);
        expect(result.length).toBeLessThanOrEqual(6000);
    });

    test('preserves legitimate article content', () => {
        const input = 'בכיר בחיזבאללה אמר היום לסוכנות הידיעות הצרפתית כי הארגון לא יתערב בתקיפה מוגבלת.\nהקו האדום הוא פגיעה בחמינאי.';
        const result = cleanArticleText(input);
        expect(result).toContain('בכיר בחיזבאללה');
        expect(result).toContain('פגיעה בחמינאי');
    });

    test('handles mixed noise and content', () => {
        const input = [
            'בכיר בחיזבאללה: "הקו האדום מבחינתינו הוא פגיעה בחמינאי"',
            'שתף ב וואצאפ',
            'שתף ב פייסבוק',
            'https://api.whatsapp.com/send?text=test',
            '.css-uv7d9g{white-space:nowrap;}',
            'בכיר בחיזבאללה אמר היום לסוכנות הידיעות הצרפתית כי הארגון לא יתערב.',
            'עוד באותו נושא:',
            'תגובות',
            '·',
            'הקו האדום הוא פגיעה במנהיג העליון עלי חמינאי.'
        ].join('\n');

        const result = cleanArticleText(input);
        expect(result).toContain('בכיר בחיזבאללה');
        expect(result).toContain('פגיעה במנהיג העליון');
        expect(result).not.toContain('שתף ב');
        expect(result).not.toContain('whatsapp');
        expect(result).not.toContain('.css-');
        expect(result).not.toContain('תגובות');
    });
});

describe('budgetArticleText', () => {
    test('returns empty string for falsy input', () => {
        expect(budgetArticleText(null)).toBe('');
        expect(budgetArticleText(undefined)).toBe('');
        expect(budgetArticleText('')).toBe('');
    });

    test('returns original text if already within maxChars budget', () => {
        const text = 'Short article text within budget.';
        expect(budgetArticleText(text, 2500)).toBe(text);
    });

    test('truncates bimodal head and tail when text exceeds maxChars', () => {
        const lead = 'LEAD: This is the very important beginning of the article where context is set.';
        const middle = 'MIDDLE: ' + 'Fluff content filler words. '.repeat(100);
        const tail = 'TAIL: The final reveal is that the answer was hidden here all along!';
        const fullText = `${lead}\n\n${middle}\n\n${tail}`;

        const budgeted = budgetArticleText(fullText, 500, 200, 150);

        expect(budgeted.length).toBeLessThanOrEqual(500);
        expect(budgeted).toContain('LEAD:');
        expect(budgeted).toContain('TAIL: The final reveal');
        expect(budgeted).toContain('[...]');
        expect(budgeted).not.toContain('Fluff content filler words. '.repeat(20));
    });

    test('handles default arguments appropriately', () => {
        const veryLongText = 'A'.repeat(5000);
        const result = budgetArticleText(veryLongText);
        expect(result.length).toBeLessThanOrEqual(2600);
        expect(result).toContain('[...]');
    });
});

describe('filterSpoilerResponse', () => {
    test('returns empty string for falsy input', () => {
        expect(filterSpoilerResponse(null)).toBe('');
        expect(filterSpoilerResponse('')).toBe('');
    });

    test('strips conversational preamble before ❓ question', () => {
        const input = 'Sure, here is the spoiler revealed from the article:\n\n❓ מה המעמד?\n💡 רק הוא קובע את כל ההחלטות';
        expect(filterSpoilerResponse(input)).toBe('❓ מה המעמד?\n💡 רק הוא קובע את כל ההחלטות');
    });

    test('strips echoed prompt instructions or meta-role text', () => {
        const input = '* Role: Spoiler tool. * Task: Reveal what clickbait headlines hide. * Step 1: Formulate a question.\n\n❓ מה המעמד של איטודיס?\n💡 הוא הסמכות המקצועית הבלעדית במועדון';
        expect(filterSpoilerResponse(input)).toBe('❓ מה המעמד של איטודיס?\n💡 הוא הסמכות המקצועית הבלעדית במועדון');
    });

    test('leaves clean spoiler response untouched', () => {
        const clean = '❓ מה קרה שם?\n💡 התרחשה תקלה במנוע';
        expect(filterSpoilerResponse(clean)).toBe(clean);
    });

    test('normalizes split Hebrew particles and prefixes like כ י to כי', () => {
        const input = '❓ מה קרה? 💡 מכבי לקחה כ י ים מדר זה הפועל';
        expect(filterSpoilerResponse(input)).toContain('כי ים מדר');
    });
});

