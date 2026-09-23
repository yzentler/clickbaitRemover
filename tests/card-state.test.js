// tests/card-state.test.js
const { tabCards, saveCard, getCards, clearCards } = require('../card-state');

describe('Card State Management', () => {
    beforeEach(() => {
        // Clear all state between tests
        tabCards.clear();
    });

    describe('saveCard', () => {
        test('creates a new card for a tab', () => {
            saveCard(1, 'card-1', { headline: 'Test', url: 'http://example.com', status: 'loading' });
            const cards = getCards(1);
            expect(cards).toHaveLength(1);
            expect(cards[0]).toEqual({
                id: 'card-1',
                headline: 'Test',
                url: 'http://example.com',
                status: 'loading'
            });
        });

        test('updates an existing card by id', () => {
            saveCard(1, 'card-1', { headline: 'Test', status: 'loading', text: 'Fetching...' });
            saveCard(1, 'card-1', { status: 'done', text: 'Result here' });
            const cards = getCards(1);
            expect(cards).toHaveLength(1);
            expect(cards[0].status).toBe('done');
            expect(cards[0].text).toBe('Result here');
            expect(cards[0].headline).toBe('Test'); // preserved from original
        });

        test('stores multiple cards per tab', () => {
            saveCard(1, 'card-1', { headline: 'First', status: 'done' });
            saveCard(1, 'card-2', { headline: 'Second', status: 'loading' });
            saveCard(1, 'card-3', { headline: 'Third', status: 'error' });
            const cards = getCards(1);
            expect(cards).toHaveLength(3);
            expect(cards.map(c => c.headline)).toEqual(['First', 'Second', 'Third']);
        });

        test('keeps cards separate between tabs', () => {
            saveCard(1, 'card-1', { headline: 'Tab 1 card' });
            saveCard(2, 'card-2', { headline: 'Tab 2 card' });
            expect(getCards(1)).toHaveLength(1);
            expect(getCards(2)).toHaveLength(1);
            expect(getCards(1)[0].headline).toBe('Tab 1 card');
            expect(getCards(2)[0].headline).toBe('Tab 2 card');
        });
    });

    describe('getCards', () => {
        test('returns null for unknown tab', () => {
            expect(getCards(999)).toBeNull();
        });

        test('returns the cards array for known tab', () => {
            saveCard(5, 'c1', { headline: 'H1' });
            const cards = getCards(5);
            expect(Array.isArray(cards)).toBe(true);
            expect(cards).toHaveLength(1);
        });
    });

    describe('clearCards', () => {
        test('removes all cards for a tab', () => {
            saveCard(1, 'card-1', { headline: 'Test' });
            saveCard(1, 'card-2', { headline: 'Test 2' });
            clearCards(1);
            expect(getCards(1)).toBeNull();
        });

        test('does not affect other tabs', () => {
            saveCard(1, 'c1', { headline: 'Tab 1' });
            saveCard(2, 'c2', { headline: 'Tab 2' });
            clearCards(1);
            expect(getCards(1)).toBeNull();
            expect(getCards(2)).toHaveLength(1);
        });

        test('is safe to call on non-existent tab', () => {
            expect(() => clearCards(999)).not.toThrow();
        });
    });

    describe('saveCard edge cases', () => {
        test('handles empty data object', () => {
            saveCard(1, 'c1', {});
            const cards = getCards(1);
            expect(cards).toHaveLength(1);
            expect(cards[0].id).toBe('c1');
        });

        test('partial update preserves existing fields', () => {
            saveCard(1, 'c1', { headline: 'H', url: 'http://x.com', status: 'loading', text: 'wait' });
            saveCard(1, 'c1', { status: 'done' });
            const card = getCards(1)[0];
            expect(card.headline).toBe('H');
            expect(card.url).toBe('http://x.com');
            expect(card.status).toBe('done');
            expect(card.text).toBe('wait'); // text wasn't updated
        });
    });
});
