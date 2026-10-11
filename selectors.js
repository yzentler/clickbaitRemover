// selectors.js — Article content & noise selectors for major news sites
//
// Site-specific selectors are tried first (most precise), then generic patterns,
// then semantic HTML fallbacks. Each group is ordered by specificity.

/**
 * Selectors for extracting article body content.
 * Tried in order — first match with >150 chars of text wins.
 */
const ARTICLE_SELECTORS = [
    // ── Site-specific: English high-traffic ──────────────

    // CNN
    '.article__content',
    '.article__content-container',
    '.zn-body__paragraph',

    // BBC News
    '[data-component="text-block"]',
    '.ssrcss-11r1m41-RichTextComponentWrapper',   // BBC rich text wrapper

    // Fox News / Washington Post / Maariv / Haaretz / N12
    '.article-body',

    // New York Times / Medium
    'section[name="articleBody"]',
    '.meteredContent',
    '.StoryBodyCompanionColumn',

    // Washington Post
    '.teaser-content',

    // The Guardian
    '.article-body-commercial-selector',
    '.dcr-1cas496',                               // Guardian article body class

    // Daily Mail / MailOnline
    '[itemprop="articleBody"]',
    '#js-article-text',
    '.article-text',

    // Reuters
    '.article-body__content',
    '.paywall-article',

    // AP News
    '.RichTextStoryBody',

    // USA Today
    '.gnt_ar_b',

    // NPR
    '#storytext',
    '.storytext',

    // The Verge
    '.duet--article--article-body-component',

    // TechCrunch / Walla
    '.article-content',

    // Wired
    '.body__inner-container',

    // BuzzFeed
    '.subbuzz-text',
    '.js-post-body',

    // Huffington Post
    '.entry__text',
    '.primary-cli',

    // Business Insider
    '.content-lock-content',
    '.piano-inline-content-wrapper',

    // CNBC
    '.ArticleBody-articleBody',
    '.FeaturedContent-articleBody',

    // Forbes
    '.article-body-container',
    '.body-container',

    // Insider / Bloomberg
    '.body-content',

    // Sky News
    '.sdc-article-body',

    // ── Clickbait-heavy sites ────────────────────────────

    // ScreenRant (Valnet network)
    '.w-article',
    'section.content-block-regular',

    // Bored Panda
    '.post-container',

    // The Sun (UK tabloid)
    'div.article__content',

    // Mirror (Reach PLC network)
    '.reach-plc-article',

    // TMZ
    '.post-content-inner',

    // Yahoo News (aggregator)
    'div.caas-body',
    '.caas-container',

    // MSN News (aggregator)
    'div.article-container',

    // People Magazine (Dotdash Meredith)
    '.article-body-content',
    'div.mntl-sc-page',

    // PageSix (NY Post network)
    '.entry-content',

    // LADbible (LBG Media)
    'div[class*="article-body_body"]',

    // ── Site-specific: Hebrew / Israeli sites ────────────

    // Israel Hayom
    '.single-post-content',
    '.single-post-sub-title',

    // Ynet
    '.art_body',
    '.public-DraftStyleDefault-block',
    '.text14',

    // Walla (additional)
    '.item-main-content',

    // Haaretz (additional)
    '.t-body-text',

    // ── Generic patterns (work on many sites) ────────────

    '.article__body',
    '.post-content',
    '.post-body',
    '.entry-content',
    '.story-body',
    '.story-content',
    '.content-body',
    '.page-content',
    '.text-content',
    '.MainContent',
    '.mainContent',
    '.main-content',

    // Broad page-level wrappers (Guardian, The Independent, Medium). These can contain related
    // links and sidebars, so they must rank below every site-specific selector above.
    '#maincontent',
    '#main-content',
    'article section',

    // ── Semantic HTML fallbacks ───────────────────────────

    'article',
    '[role="article"]',
    '[role="main"]',
    'main',
];

/**
 * Per-host selectors, tried before the generic list. Keys are registrable hostnames;
 * subdomains match (sports.walla.co.il → walla.co.il).
 */
const SITE_SELECTORS = {
    'israelhayom.co.il': ['.single-post-content'],
    'ynet.co.il': ['.art_body', '.public-DraftStyleDefault-block', '.text14'],
    'walla.co.il': ['.item-main-content', '.article-content'],
    'haaretz.co.il': ['.t-body-text', '.article-body'],
    'n12.co.il': ['.article-body'],
    'mako.co.il': ['.article-body'],
    'maariv.co.il': ['.article-body'],
};

/**
 * Selectors to try for a given hostname: host-specific first, then the generic list.
 * @param {string} [hostname]
 * @returns {string[]}
 */
function getArticleSelectors(hostname) {
    const host = (hostname || '').toLowerCase().replace(/^www\./, '');
    const specific = [];
    for (const [domain, selectors] of Object.entries(SITE_SELECTORS)) {
        if (host === domain || host.endsWith('.' + domain)) specific.push(...selectors);
    }
    if (specific.length === 0) return ARTICLE_SELECTORS;
    return [...new Set([...specific, ...ARTICLE_SELECTORS])];
}

/**
 * Noise selectors — elements to strip before extracting text.
 * Applied via querySelectorAll(...).forEach(el => el.remove()).
 */
const NOISE_SELECTORS = [
    // Standard HTML noise
    'script', 'style', 'noscript', 'svg',

    // Layout / navigation
    'nav', 'footer', 'header', 'aside', 'iframe',

    // Ads
    '.ad-container', '.ad-feedback', '.ad-slot', '.ad-wrapper',
    // `[class*="ad-"]` also matched lead-/read-/thread-; anchor to a class-token start instead.
    '[class^="ad-"]', '[class*=" ad-"]', '[class*="advert"]',
    '[id*="google_ads"]', '[id*="taboola"]', '[id*="outbrain"]',
    'div[data-component="ads-container"]',

    // Social / share
    '.social-share', '.share-buttons', '.article-share',
    '.article-footer-share', '.vossi-social-share_labelled-list',
    '[class*="share"]', '[class*="social"]',
    '[data-testid="social-share-container"]',

    // Comments
    '[class*="comment"]', '#comments',

    // Related / recommended
    '[class*="related"]', '[class*="recommended"]', '[class*="recirculation"]',
    '.article__related-content',
    'div[data-component="related-content"]',

    // Newsletter / sign-up
    '[class*="newsletter"]', '[class*="signup"]', '[class*="subscribe"]',

    // Sidebars and widgets
    '.sidebar', '.widget', '.breadcrumb',

    // Media captions and credits (often noise in text extraction)
    'figcaption', '.image-credit', '.media-caption',

    // Video players (not useful for text extraction)
    '.featured-video', '.video-player', '[class*="video-"]',

    // Clickbait-site-specific noise
    '.sensa-widget-wrapper',                       // ScreenRant AI summaries
    '.post-vote-button', '.quizzes-text',          // Bored Panda
    '.newsletter-block',                           // The Sun
    '.share-bar', '.live-event-summary',           // Mirror
    '.hero-bar__card-link', '.masthead-tip',        // TMZ
    '.caas-attr-provider-logo', '.gemini-ad',       // Yahoo News
    '.caas-side-column',                           // Yahoo News sidebar
    '.article-cont-read-button', '.native-ad',     // MSN
    '.mntl-sc-block-ad', '.mntl-attribution',      // People (Dotdash Meredith)
    '.popular-shopping', '.nyp-social-share',       // PageSix
    '.advert-container', '.quick-link',            // LADbible
].join(', ');

// Export for both service worker (importScripts) and Node.js (Jest)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ARTICLE_SELECTORS, NOISE_SELECTORS, SITE_SELECTORS, getArticleSelectors };
}
