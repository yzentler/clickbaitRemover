// llm-providers.js — LLM provider abstraction layer

// ─── Constants ───────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemma-3-27b-it';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434/api/generate';
const DEFAULT_OLLAMA_MODEL = 'llama3';

const LANGUAGE_THRESHOLD = 0.3;   // min ratio of script chars to classify language

// ─── High-level entry point ──────────────────────────────────

/**
 * Build the full prompt from headline + article text, detect language,
 * inject an explicit language instruction, and call the active LLM provider.
 * @param {string} text     - Article text
 * @param {string} headline - Headline text
 * @returns {Promise<string>} LLM response
 */
async function callLLM(text, headline) {
    console.log(`[LLM] Headline sent: ${headline || '(none)'}`);
    console.log(`[LLM] Article text length: ${text.length} chars`);

    const lang = detectLanguage(headline || '', text);
    console.log(`[LLM] Detected language: ${lang}`);

    let prompt = PROMPTS.summarize
        .replace('{{HEADLINE}}', headline || '')
        .replace('{{TEXT}}', text);

    // Inject explicit language instruction right before the headline
    const langLine = `\nIMPORTANT: You MUST respond in ${lang}. Both the question and the spoiler answer MUST be written in ${lang}.\n`;
    prompt = prompt.replace('---\nHEADLINE:', `${langLine}---\nHEADLINE:`);

    return callLLMByProvider(prompt);
}

// ─── Language detection ──────────────────────────────────────

// Unicode ranges used for script classification
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
    const sample = (headline + ' ' + articleText.substring(0, 500)).trim();

    const hebrewCount = (sample.match(HEBREW_CHAR_RE) || []).length;
    const arabicCount = (sample.match(ARABIC_CHAR_RE) || []).length;
    const latinCount = (sample.match(LATIN_CHAR_RE) || []).length;

    const total = hebrewCount + arabicCount + latinCount;
    if (total === 0) return 'English';                       // fallback

    if (hebrewCount / total > LANGUAGE_THRESHOLD) return 'Hebrew';
    if (arabicCount / total > LANGUAGE_THRESHOLD) return 'Arabic';
    return 'English';
}

// ─── Provider dispatcher ─────────────────────────────────────

/**
 * Read provider settings from storage and dispatch to the correct backend.
 * @param {string} prompt - Full prompt to send
 * @returns {Promise<string>} LLM response
 */
async function callLLMByProvider(prompt) {
    const settings = await chrome.storage.local.get([
        'provider', 'apiUrl', 'modelName',
        'geminiApiKey', 'geminiModel',
        'groqApiKey', 'groqModel',
    ]);

    const provider = settings.provider || 'ollama';
    console.log(`[LLM] Using provider: ${provider}`);

    switch (provider) {
        case 'gemini': return callGemini(prompt, settings.geminiApiKey, settings.geminiModel);
        case 'groq': return callGroq(prompt, settings.groqApiKey, settings.groqModel);
        default: return callOllama(prompt, settings.apiUrl, settings.modelName);
    }
}

// ─── Ollama ──────────────────────────────────────────────────

/**
 * Call Ollama local API.
 * @param {string} prompt
 * @param {string} [apiUrl]   - Ollama endpoint (default: localhost:11434)
 * @param {string} [modelName] - Model name (default: llama3)
 * @returns {Promise<string>}
 */
async function callOllama(prompt, apiUrl, modelName) {
    const url = apiUrl || DEFAULT_OLLAMA_URL;
    const model = modelName || DEFAULT_OLLAMA_MODEL;

    console.log(`[Ollama] Sending request to ${url} with model ${model}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    console.log(`[Ollama] Response received: ${data.response.substring(0, 200)}…`);
    return data.response.trim();
}

// ─── Gemini ──────────────────────────────────────────────────

/**
 * Call Google Gemini API.
 * @param {string} prompt
 * @param {string} apiKey    - Gemini API key
 * @param {string} [modelName] - Model name (default: gemma-3-27b-it)
 * @returns {Promise<string>}
 */
async function callGemini(prompt, apiKey, modelName) {
    if (!apiKey) {
        throw new Error('Gemini API key not configured. Open extension settings.');
    }

    const model = modelName || DEFAULT_GEMINI_MODEL;
    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

    console.log(`[Gemini] Sending request to model ${model}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini Error: ${response.status} ${errText}`);
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
 * Call Groq cloud API (OpenAI-compatible).
 * @param {string} prompt
 * @param {string} apiKey    - Groq API key
 * @param {string} [modelName] - Model name (default: llama-3.3-70b-versatile)
 * @returns {Promise<string>}
 */
async function callGroq(prompt, apiKey, modelName) {
    if (!apiKey) {
        throw new Error('Groq API key not configured. Open extension settings.');
    }

    const model = modelName || DEFAULT_GROQ_MODEL;

    console.log(`[Groq] Sending request to model ${model}`);

    const response = await fetch(GROQ_API_BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 300,
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('Groq returned an empty or unexpected response.');
    }

    console.log(`[Groq] Response received: ${text.substring(0, 200)}…`);
    return text.trim();
}

// ─── Exports ─────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        callLLM, callLLMByProvider, detectLanguage,
        callOllama, callGemini, callGroq,
        GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
        GROQ_API_BASE, DEFAULT_GROQ_MODEL,
        DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL,
        LANGUAGE_THRESHOLD,
    };
}
