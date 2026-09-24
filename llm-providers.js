// llm-providers.js — LLM provider abstraction layer with SOTA speed models and streaming

// ─── Constants ───────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434/api/generate';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:3b';

const LANGUAGE_THRESHOLD = 0.3;   // min ratio of script chars to classify language

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

    // If budgetArticleText is available, budget to 2500 chars for fast prefill
    let processedText = text;
    if (typeof budgetArticleText === 'function') {
        processedText = budgetArticleText(text, 2500, 1500, 1000);
    }

    let prompt = PROMPTS.summarize
        .replace('{{HEADLINE}}', headline || '')
        .replace('{{TEXT}}', processedText);

    // Inject explicit language instruction right before the headline
    const langLine = `\nIMPORTANT: You MUST respond in ${lang}. Both the question and the spoiler answer MUST be written in ${lang}.\n`;
    if (prompt.includes('---\nHEADLINE:')) {
        prompt = prompt.replace('---\nHEADLINE:', `${langLine}---\nHEADLINE:`);
    } else {
        prompt += langLine;
    }

    // Append recency directive at prompt end to reinforce the article's language
    const endDirective = `\n---\nIMPORTANT: The article text above is in ${lang}.\nBoth the question and the spoiler answer MUST be written in ${lang}.\nStart your response immediately with ❓ in ${lang}:`;
    prompt += endDirective;

    // Wrap onChunk to filter preamble or echoed rules in real-time
    let wrappedOnChunk = undefined;
    if (typeof onChunk === 'function') {
        wrappedOnChunk = (chunk, accumulated) => {
            const clean = typeof filterSpoilerResponse === 'function'
                ? filterSpoilerResponse(accumulated)
                : accumulated;
            onChunk(chunk, clean);
        };
    }

    const rawResult = await callLLMByProvider(prompt, wrappedOnChunk);
    const finalResult = typeof filterSpoilerResponse === 'function'
        ? filterSpoilerResponse(rawResult)
        : rawResult;

    return finalResult;
}

let _buildMultiPrompt = typeof buildMultiArticlePrompt === 'function' ? buildMultiArticlePrompt : null;
let _parseMultiResponse = typeof parseMultiArticleResponse === 'function' ? parseMultiArticleResponse : null;
if (!_buildMultiPrompt && typeof require === 'function') {
    try {
        const batchMod = require('./batch-extractor');
        _buildMultiPrompt = batchMod.buildMultiArticlePrompt;
        _parseMultiResponse = batchMod.parseMultiArticleResponse;
    } catch (_e) {}
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

    const promptBuilder = typeof buildMultiArticlePrompt === 'function' ? buildMultiArticlePrompt : _buildMultiPrompt;
    const responseParser = typeof parseMultiArticleResponse === 'function' ? parseMultiArticleResponse : _parseMultiResponse;

    const prompt = typeof promptBuilder === 'function'
        ? promptBuilder(items)
        : '';

    console.log(`[LLM] Calling batch LLM for ${items.length} articles`);
    const rawResult = await callLLMByProvider(prompt);

    const parsedResults = typeof responseParser === 'function'
        ? responseParser(rawResult, items.length)
        : [rawResult];

    return parsedResults;
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

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream }),
    });

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
 * @param {string} [modelName] - Model name (default: gemini-3.5-flash-lite)
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
    const url = stream
        ? `${GEMINI_API_BASE}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
        : `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

    console.log(`[Gemini] Sending request to model ${model} (stream: ${stream})`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
        }),
    });

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
        temperature: 0.2,
        max_tokens: 600,
    };
    if (stream) {
        bodyPayload.stream = true;
    }

    const response = await fetch(GROQ_API_BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyPayload),
    });

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

/**
 * Call Chrome's on-device Gemini Nano model via the Prompt API.
 * @param {string} prompt
 * @param {function(string, string): void} [onChunk] - Optional stream token callback
 * @returns {Promise<string>}
 */
async function callChromeAI(prompt, onChunk) {
    const ai = (typeof self !== 'undefined' && self.ai) ? self.ai : ((typeof window !== 'undefined') ? window.ai : null);
    if (!ai?.languageModel) {
        throw new Error('Chrome Built-in AI is not available in this environment.');
    }

    const availability = await ai.languageModel.availability();
    if (availability !== 'readily' && availability !== 'available') {
        throw new Error(`Chrome Built-in AI is not available (status: ${availability}).`);
    }

    const session = await ai.languageModel.create();

    if (typeof onChunk === 'function' && typeof session.promptStreaming === 'function') {
        const stream = session.promptStreaming(prompt);
        const reader = stream.getReader();
        let accumulated = '';
        let previousLength = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            let delta = value;
            if (typeof value === 'string' && value.startsWith(accumulated) && accumulated.length > 0) {
                delta = value.substring(previousLength);
                accumulated = value;
                previousLength = value.length;
            } else {
                accumulated += value;
                previousLength = accumulated.length;
            }
            onChunk(delta, accumulated);
        }
        return accumulated.trim();
    }

    const response = await session.prompt(prompt);
    return response.trim();
}

// ─── Exports ─────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        callLLM, callBatchLLM, callLLMByProvider, detectLanguage,
        callOllama, callGemini, callGroq, callChromeAI,
        readSseStream, readNdjsonStream,
        GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
        GROQ_API_BASE, DEFAULT_GROQ_MODEL,
        DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL,
        LANGUAGE_THRESHOLD,
    };
}
