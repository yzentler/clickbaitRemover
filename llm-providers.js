// llm-providers.js — LLM provider abstraction layer with SOTA speed models and streaming

import {
    GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
    GROQ_API_BASE, DEFAULT_GROQ_MODEL,
    DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL,
    LANGUAGE_THRESHOLD,
    LLM_TIMEOUT_MS, LLM_MAX_RETRIES, LLM_RETRY_BASE_DELAY_MS,
    LLM_TEMPERATURE, LLM_MAX_OUTPUT_TOKENS,
} from './config.js';
import { PROMPTS } from './prompts.js';
import { budgetArticleText, filterSpoilerResponse } from './text-cleaner.js';
import { buildMultiArticlePrompt, parseMultiArticleResponse } from './batch-extractor.js';

// ─── Request plumbing ────────────────────────────────────────

/** Mutable so tests can zero the delays. */
const retryConfig = {
    timeoutMs: LLM_TIMEOUT_MS,
    maxRetries: LLM_MAX_RETRIES,
    baseDelayMs: LLM_RETRY_BASE_DELAY_MS,
};

const MAX_RETRY_AFTER_MS = 10000;   // don't stall a card on a long server-requested wait

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseRetryAfterMs(header) {
    if (!header) return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * fetch() with a response-start timeout and bounded retries on 429 / 503.
 * Retrying here is safe because nothing has been streamed to the UI yet.
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} label - Provider name for error messages
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init, label) {
    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), retryConfig.timeoutMs);
        let response;
        try {
            response = await fetch(url, { ...init, signal: controller.signal });
        } catch (err) {
            if (err?.name === 'AbortError') {
                throw new Error(`${label} did not respond within ${Math.round(retryConfig.timeoutMs / 1000)}s.`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        const retryable = response.status === 429 || response.status === 503;
        if (!retryable || attempt >= retryConfig.maxRetries) return response;

        const waitMs = parseRetryAfterMs(response.headers?.get?.('retry-after'))
            ?? retryConfig.baseDelayMs * 2 ** attempt;
        if (waitMs > MAX_RETRY_AFTER_MS) return response;

        console.warn(`[${label}] HTTP ${response.status}; retrying in ${waitMs}ms (attempt ${attempt + 1}/${retryConfig.maxRetries})`);
        await sleep(waitMs);
    }
}

// ─── Stream Parsers ──────────────────────────────────────────

/**
 * Consume a Server-Sent Events (SSE) stream from a Response object.
 * @param {Response} response
 * @param {function(any): void} onData - Called with each parsed JSON data payload
 */
async function readSseStream(response, onData) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep last incomplete line

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') return;
            if (trimmed.startsWith('data: ')) {
                try {
                    const json = JSON.parse(trimmed.slice(6));
                    onData(json);
                } catch (_err) {
                    // ignore malformed SSE line
                }
            }
        }
    }

    if (buffer && buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
        try {
            const json = JSON.parse(buffer.trim().slice(6));
            onData(json);
        } catch (_err) { }
    }
}

/**
 * Consume a newline-delimited JSON (NDJSON) stream from a Response object (Ollama).
 * @param {Response} response
 * @param {function(any): void} onData - Called with each parsed JSON object
 */
async function readNdjsonStream(response, onData) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const json = JSON.parse(trimmed);
                onData(json);
            } catch (_err) { }
        }
    }

    if (buffer && buffer.trim()) {
        try {
            const json = JSON.parse(buffer.trim());
            onData(json);
        } catch (_err) { }
    }
}

// ─── High-level entry point ──────────────────────────────────

/**
 * Build the prompt from headline + article text, detect language,
 * and call the active LLM provider with optional streaming.
 * @param {string} text     - Article text
 * @param {string} headline - Headline text
 * @param {function(string, string): void} [onChunk] - Optional stream token callback (chunk, accumulated)
 * @returns {Promise<string>} LLM response
 */
async function callLLM(text, headline, onChunk) {
    console.log(`[LLM] Headline sent: ${headline || '(none)'}`);
    console.log(`[LLM] Article text length: ${text.length} chars`);

    const lang = detectLanguage(headline || '', text);
    console.log(`[LLM] Detected language: ${lang}`);

    // Budget to 2500 chars for fast prefill
    const processedText = budgetArticleText(text, 2500, 1500, 1000);

    let prompt = PROMPTS.summarize
        .replace('{{HEADLINE}}', () => headline || '')   // function replacers: article text may contain `$&`, `$'`
        .replace('{{TEXT}}', () => processedText);

    // Inject explicit language instruction right before the headline
    const langLine = `\nIMPORTANT: You MUST respond in ${lang}. Both the question and the spoiler answer MUST be written in ${lang}.\n`;
    if (prompt.includes('---\nHEADLINE:')) {
        prompt = prompt.replace('---\nHEADLINE:', () => `${langLine}---\nHEADLINE:`);
    } else {
        prompt += langLine;
    }

    // Append recency directive at prompt end to reinforce the article's language
    const endDirective = `\n---\nIMPORTANT: The article text above is in ${lang}.\nBoth the question and the spoiler answer MUST be written in ${lang}.\nStart your response immediately with ❓ in ${lang}:`;
    prompt += endDirective;

    // Wrap onChunk to filter preamble or echoed rules in real-time
    let wrappedOnChunk = undefined;
    if (typeof onChunk === 'function') {
        wrappedOnChunk = (chunk, accumulated) => onChunk(chunk, filterSpoilerResponse(accumulated));
    }

    const rawResult = await callLLMByProvider(prompt, wrappedOnChunk);
    return filterSpoilerResponse(rawResult);
}

/**
 * Call the active LLM provider for a batch of articles (up to 3).
 * Returns an array of spoiler strings, one for each article.
 * @param {Array<{ headline: string, text: string }>} items
 * @returns {Promise<Array<string>>}
 */
async function callBatchLLM(items) {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (items.length === 1) {
        const singleResult = await callLLM(items[0].text, items[0].headline);
        return [singleResult];
    }

    // Same prefill budget idea as the single-article path, split across the batch
    const budgeted = items.map(item => ({
        headline: item.headline,
        text: budgetArticleText(item.text || '', 2000, 1200, 800),
    }));

    console.log(`[LLM] Calling batch LLM for ${items.length} articles`);
    const rawResult = await callLLMByProvider(buildMultiArticlePrompt(budgeted));

    return parseMultiArticleResponse(rawResult, items.length).map(filterSpoilerResponse);
}

// ─── Language detection ──────────────────────────────────────

const HEBREW_CHAR_RE = /[\u0590-\u05FF]/g;
const ARABIC_CHAR_RE = /[\u0600-\u06FF]/g;
const LATIN_CHAR_RE = /[a-zA-Z]/g;

/**
 * Detect the language of content by analysing character-script distribution.
 * Uses the headline plus the first 500 chars of article text as a sample.
 * @param {string} headline
 * @param {string} articleText
 * @returns {string} Language name — 'English', 'Hebrew', or 'Arabic'
 */
function detectLanguage(headline, articleText) {
    // 1. Analyze article text first (up to 1000 chars) as primary source of truth
    const articleSample = (articleText || '').substring(0, 1000).trim();
    if (articleSample.length > 0) {
        const hebrewCount = (articleSample.match(HEBREW_CHAR_RE) || []).length;
        const arabicCount = (articleSample.match(ARABIC_CHAR_RE) || []).length;
        const latinCount = (articleSample.match(LATIN_CHAR_RE) || []).length;
        const total = hebrewCount + arabicCount + latinCount;
        if (total > 0) {
            // Lower threshold (0.15) for non-Latin scripts to handle texts with transliteration/names
            if (hebrewCount / total > 0.15) return 'Hebrew';
            if (arabicCount / total > 0.15) return 'Arabic';
            if (latinCount / total > 0.5) return 'English';
        }
    }

    // 2. Fall back to combined headline + article sample
    const sample = (headline + ' ' + (articleText || '').substring(0, 500)).trim();

    const hebrewCount = (sample.match(HEBREW_CHAR_RE) || []).length;
    const arabicCount = (sample.match(ARABIC_CHAR_RE) || []).length;
    const latinCount = (sample.match(LATIN_CHAR_RE) || []).length;

    const total = hebrewCount + arabicCount + latinCount;
    if (total === 0) return 'English';

    if (hebrewCount / total > LANGUAGE_THRESHOLD) return 'Hebrew';
    if (arabicCount / total > LANGUAGE_THRESHOLD) return 'Arabic';
    return 'English';
}

// ─── Provider dispatcher ─────────────────────────────────────

/**
 * Read provider settings from storage and dispatch to the correct backend.
 * @param {string} prompt - Full prompt to send
 * @param {function(string, string): void} [onChunk] - Optional streaming callback
 * @returns {Promise<string>} LLM response
 */
async function callLLMByProvider(prompt, onChunk) {
    const settings = await chrome.storage.local.get([
        'provider', 'apiUrl', 'modelName',
        'geminiApiKey', 'geminiModel',
        'groqApiKey', 'groqModel',
    ]);

    const provider = settings.provider || 'ollama';
    console.log(`[LLM] Using provider: ${provider}`);

    switch (provider) {
        case 'gemini': return callGemini(prompt, settings.geminiApiKey, settings.geminiModel, onChunk);
        case 'groq': return callGroq(prompt, settings.groqApiKey, settings.groqModel, onChunk);
        case 'chrome-ai': return callChromeAI(prompt, onChunk);
        default: return callOllama(prompt, settings.apiUrl, settings.modelName, onChunk);
    }
}

// ─── Ollama ──────────────────────────────────────────────────

/**
 * Call Ollama local API with streaming support.
 * @param {string} prompt
 * @param {string} [apiUrl]   - Ollama endpoint (default: localhost:11434)
 * @param {string} [modelName] - Model name (default: qwen2.5:3b)
 * @param {function(string, string): void} [onChunk] - Optional stream token callback
 * @returns {Promise<string>}
 */
async function callOllama(prompt, apiUrl, modelName, onChunk) {
    const url = apiUrl || DEFAULT_OLLAMA_URL;
    const model = modelName || DEFAULT_OLLAMA_MODEL;
    const stream = typeof onChunk === 'function';

    console.log(`[Ollama] Sending request to ${url} with model ${model} (stream: ${stream})`);

    const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model, prompt, stream,
            options: { temperature: LLM_TEMPERATURE, num_predict: LLM_MAX_OUTPUT_TOKENS },
        }),
    }, 'Ollama');

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama Error: ${response.status} ${errText}`);
    }

    if (stream) {
        let accumulated = '';
        await readNdjsonStream(response, (data) => {
            if (data.response) {
                accumulated += data.response;
                onChunk(data.response, accumulated);
            }
        });
        return accumulated.trim();
    }

    const data = await response.json();
    console.log(`[Ollama] Response received: ${data.response?.substring(0, 200)}…`);
    return (data.response || '').trim();
}

// ─── Gemini ──────────────────────────────────────────────────

/**
 * Call Google Gemini API with streaming support.
 * @param {string} prompt
 * @param {string} apiKey    - Gemini API key
 * @param {string} [modelName] - Model name (default: DEFAULT_GEMINI_MODEL)
 * @param {function(string, string): void} [onChunk] - Optional stream token callback
 * @returns {Promise<string>}
 */
async function callGemini(prompt, apiKey, modelName, onChunk) {
    if (!apiKey) {
        throw new Error('Gemini API key not configured. Open extension settings.');
    }

    let model = modelName || DEFAULT_GEMINI_MODEL;
    if (model && model.includes('latest')) {
        model = DEFAULT_GEMINI_MODEL;
    }
    const stream = typeof onChunk === 'function';
    // API key goes in a header, not the URL, so it stays out of logs and network traces
    const url = stream
        ? `${GEMINI_API_BASE}/${model}:streamGenerateContent?alt=sse`
        : `${GEMINI_API_BASE}/${model}:generateContent`;

    const generationConfig = { temperature: LLM_TEMPERATURE };
    if (/^gemini-2\.5-flash/.test(model)) {
        // 2.5 Flash "thinks" by default; this task is short extraction, so skip it for latency
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
        generationConfig.maxOutputTokens = LLM_MAX_OUTPUT_TOKENS;
    }

    console.log(`[Gemini] Sending request to model ${model} (stream: ${stream})`);

    const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig,
        }),
    }, 'Gemini');

    if (!response.ok) {
        if (response.status === 404 && model !== DEFAULT_GEMINI_MODEL) {
            console.warn(`[Gemini] Model ${model} returned 404. Retrying with default model ${DEFAULT_GEMINI_MODEL}`);
            return callGemini(prompt, apiKey, DEFAULT_GEMINI_MODEL, onChunk);
        }
        const errText = await response.text();
        throw new Error(`Gemini Error: ${response.status} ${errText}`);
    }

    if (stream) {
        let accumulated = '';
        await readSseStream(response, (data) => {
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                accumulated += text;
                onChunk(text, accumulated);
            }
        });
        return accumulated.trim();
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Gemini returned an empty or unexpected response.');
    }

    console.log(`[Gemini] Response received: ${text.substring(0, 200)}…`);
    return text.trim();
}

// ─── Groq ────────────────────────────────────────────────────

/**
 * Call Groq cloud API with streaming support.
 * @param {string} prompt
 * @param {string} apiKey    - Groq API key
 * @param {string} [modelName] - Model name (default: llama-3.1-8b-instant)
 * @param {function(string, string): void} [onChunk] - Optional stream token callback
 * @returns {Promise<string>}
 */
async function callGroq(prompt, apiKey, modelName, onChunk) {
    if (!apiKey) {
        throw new Error('Groq API key not configured. Open extension settings.');
    }

    const model = modelName || DEFAULT_GROQ_MODEL;
    const stream = typeof onChunk === 'function';

    console.log(`[Groq] Sending request to model ${model} (stream: ${stream})`);

    const bodyPayload = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: LLM_TEMPERATURE,
        max_tokens: LLM_MAX_OUTPUT_TOKENS,
    };
    if (stream) {
        bodyPayload.stream = true;
    }

    const response = await fetchWithRetry(GROQ_API_BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyPayload),
    }, 'Groq');

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq Error: ${response.status} ${errText}`);
    }

    if (stream) {
        let accumulated = '';
        await readSseStream(response, (data) => {
            const text = data.choices?.[0]?.delta?.content;
            if (text) {
                accumulated += text;
                onChunk(text, accumulated);
            }
        });
        return accumulated.trim();
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('Groq returned an empty or unexpected response.');
    }

    console.log(`[Groq] Response received: ${text.substring(0, 200)}…`);
    return text.trim();
}

// ─── Chrome Built-in AI (Prompt API) ─────────────────────────

/** The Prompt API is `LanguageModel` in current Chrome; older builds used `ai.languageModel`. */
function getChromeAiApi() {
    const scope = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null);
    return scope?.LanguageModel || scope?.ai?.languageModel || null;
}

/**
 * Call Chrome's on-device Gemini Nano model via the Prompt API.
 * Note: availability inside a service worker depends on the Chrome version.
 * @param {string} prompt
 * @param {function(string, string): void} [onChunk] - Optional stream token callback
 * @returns {Promise<string>}
 */
async function callChromeAI(prompt, onChunk) {
    const api = getChromeAiApi();
    if (!api) {
        throw new Error('Chrome Built-in AI is not available in this environment.');
    }

    const availability = await api.availability();
    if (availability !== 'readily' && availability !== 'available') {
        throw new Error(`Chrome Built-in AI is not available (status: ${availability}).`);
    }

    const session = await api.create();
    try {
        if (typeof onChunk === 'function' && typeof session.promptStreaming === 'function') {
            const reader = session.promptStreaming(prompt).getReader();
            let accumulated = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Some builds stream cumulative text, others stream deltas
                const text = String(value);
                const delta = accumulated && text.startsWith(accumulated) ? text.slice(accumulated.length) : text;
                accumulated = accumulated && text.startsWith(accumulated) ? text : accumulated + text;
                onChunk(delta, accumulated);
            }
            return accumulated.trim();
        }

        const response = await session.prompt(prompt);
        return response.trim();
    } finally {
        session.destroy?.();
    }
}

// ─── Exports ─────────────────────────────────────────────────

export {
    callLLM, callBatchLLM, callLLMByProvider, detectLanguage,
    callOllama, callGemini, callGroq, callChromeAI,
    readSseStream, readNdjsonStream,
    retryConfig,
    GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
    GROQ_API_BASE, DEFAULT_GROQ_MODEL,
    DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL,
    LANGUAGE_THRESHOLD,
};
