// config.js — Shared constants and defaults (used by the service worker and the popup)

// ─── Providers ───────────────────────────────────────────────

export const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_API_BASE = `${GEMINI_API_ROOT}/models`;
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const GROQ_API_ROOT = 'https://api.groq.com/openai/v1';
export const GROQ_API_BASE = `${GROQ_API_ROOT}/chat/completions`;
export const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434/api/generate';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:3b';

export const LANGUAGE_THRESHOLD = 0.3;   // min ratio of script chars to classify language

// ─── LLM requests ────────────────────────────────────────────

export const LLM_TIMEOUT_MS = 45000;     // time allowed for the provider to start responding
export const LLM_MAX_RETRIES = 2;        // retries on 429 / 503
export const LLM_RETRY_BASE_DELAY_MS = 600;
export const LLM_TEMPERATURE = 0.2;
export const LLM_MAX_OUTPUT_TOKENS = 600;

// ─── Extraction ──────────────────────────────────────────────

export const MIN_TEXT_LENGTH = 150;      // below this, selector match is "too short"
export const MIN_FETCH_LENGTH = 200;     // below this, fast-fetch is considered failed
export const MAX_EXTRACTED_LENGTH = 8000;
export const BATCH_ARTICLE_TIMEOUT_MS = 8000;
export const BATCH_CHUNK_SIZE = 3;
export const MAX_VIEWPORT_CANDIDATES = 15;

// ─── Cache ───────────────────────────────────────────────────

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 300;
export const CACHE_KEY_PREFIX = 'cbr_cache_';

// ─── Cards ───────────────────────────────────────────────────

export const STALE_LOADING_CARD_MS = 2 * 60 * 1000;   // a "loading" card older than this was interrupted
