// tests/structured-extractor.test.js
const { extractStructuredArticleText } = require('../structured-extractor');

describe('extractStructuredArticleText', () => {
    test('returns empty string for falsy input', () => {
        expect(extractStructuredArticleText(null)).toBe('');
        expect(extractStructuredArticleText(undefined)).toBe('');
        expect(extractStructuredArticleText('')).toBe('');
    });

    test('extracts articleBody from simple JSON-LD', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script type="application/ld+json">
                {
                    "@context": "https://schema.org",
                    "@type": "NewsArticle",
                    "headline": "Amazing Breakthrough Revealed",
                    "articleBody": "Scientists in Tel Aviv have announced a major discovery that solves the energy puzzle once and for all after twenty years of research."
                }
                </script>
            </head>
            <body><h1>Other markup</h1></body>
            </html>
        `;
        const result = extractStructuredArticleText(html);
        expect(result).toContain('Scientists in Tel Aviv have announced');
    });

    test('extracts articleBody from JSON-LD with @graph array', () => {
        const html = `
            <html>
            <head>
                <script type="application/ld+json">
                {
                    "@context": "https://schema.org",
                    "@graph": [
                        { "@type": "WebSite", "name": "News Site" },
                        {
                            "@type": "Article",
                            "headline": "Shocking Revelation",
                            "articleBody": "The minister revealed that the secret budget will be redirected towards hospital expansions nationwide starting next month."
                        }
                    ]
                }
                </script>
            </head>
            <body></body>
            </html>
        `;
        const result = extractStructuredArticleText(html);
        expect(result).toContain('The minister revealed that the secret budget');
    });

    test('extracts text from Next.js __NEXT_DATA__ hydration script', () => {
        const nextData = {
            props: {
                pageProps: {
                    article: {
                        title: "Exclusive Report",
                        body: "Sources confirm that the upcoming policy change will take effect on January first across all municipal offices."
                    }
                }
            }
        };
        const html = `
            <html>
            <head></head>
            <body>
                <script id="__NEXT_DATA__" type="application/json">
                ${JSON.stringify(nextData)}
                </script>
            </body>
            </html>
        `;
        const result = extractStructuredArticleText(html);
        expect(result).toContain('Sources confirm that the upcoming policy change');
    });

    test('extracts og:description when JSON-LD is absent and description is substantive', () => {
        const html = `
            <html>
            <head>
                <meta property="og:description" content="Officials confirmed that the entire highway will be closed for renovation starting Sunday evening at midnight until Friday.">
            </head>
            <body></body>
            </html>
        `;
        const result = extractStructuredArticleText(html);
        expect(result).toContain('Officials confirmed that the entire highway will be closed');
    });

    test('strips HTML tags and normalizes entities in extracted structured text', () => {
        const html = `
            <script type="application/ld+json">
            {
                "@type": "NewsArticle",
                "articleBody": "<p>First paragraph with <b>bold text</b> &amp; key details about the upcoming city policy change.</p><p>Second paragraph provides additional context for the residents of the district.</p>"
            }
            </script>
        `;
        const result = extractStructuredArticleText(html);
        expect(result).not.toContain('<p>');
        expect(result).not.toContain('<b>');
        expect(result).toContain('&');
        expect(result).toContain('First paragraph with bold text');
        expect(result).toContain('Second paragraph provides additional context');
    });

    test('returns empty string if structured data is too short or noise', () => {
        const html = `
            <script type="application/ld+json">
            {
                "@type": "NewsArticle",
                "articleBody": "Too short"
            }
            </script>
        `;
        const result = extractStructuredArticleText(html);
        expect(result).toBe('');
    });
});
