// tests/llm-providers.test.js
//
// Tests for LLM provider functions.
// Chrome APIs and fetch are mocked — we only test response parsing and error handling.

// Mock chrome.storage.local
global.chrome = {
    storage: {
        local: {
            get: jest.fn()
        }
    }
};

// Mock PROMPTS (loaded via importScripts in real extension)
global.PROMPTS = {
    summarize: 'You are a spoiler tool.\n---\nHEADLINE:\n{{HEADLINE}}\n\nARTICLE TEXT:\n{{TEXT}}'
};

const {
    callOllama, callGemini, callGroq,
    callLLM, callLLMByProvider, detectLanguage,
    GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
    GROQ_API_BASE, DEFAULT_GROQ_MODEL
} = require('../llm-providers');

// Suppress console.log in tests
beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => { });
});
afterAll(() => {
    console.log.mockRestore();
});

describe('callOllama', () => {
    test('returns trimmed response on success', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: '  Answer text here  ' })
        });

        const result = await callOllama('test prompt', 'http://localhost:11434/api/generate', 'llama3');
        expect(result).toBe('Answer text here');
        expect(fetch).toHaveBeenCalledWith(
            'http://localhost:11434/api/generate',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"model":"llama3"')
            })
        );
    });

    test('uses default URL and model when not provided', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: 'result' })
        });

        await callOllama('prompt');
        expect(fetch).toHaveBeenCalledWith(
            'http://localhost:11434/api/generate',
            expect.objectContaining({
                body: expect.stringContaining('"model":"llama3"')
            })
        );
    });

    test('throws on HTTP error', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error'
        });

        await expect(callOllama('prompt')).rejects.toThrow('Ollama Error: 500');
    });
});

describe('callGemini', () => {
    test('returns trimmed response on success', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{
                    content: { parts: [{ text: '  Gemini answer  ' }] }
                }]
            })
        });

        const result = await callGemini('prompt', 'test-api-key', 'gemma-3-27b-it');
        expect(result).toBe('Gemini answer');
    });

    test('throws if no API key provided', async () => {
        await expect(callGemini('prompt', '', 'model')).rejects.toThrow('API key not configured');
        await expect(callGemini('prompt', null, 'model')).rejects.toThrow('API key not configured');
    });

    test('uses default model when not provided', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'response' }] } }]
            })
        });

        await callGemini('prompt', 'key');
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining(DEFAULT_GEMINI_MODEL),
            expect.anything()
        );
    });

    test('throws on empty response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ candidates: [] })
        });

        await expect(callGemini('prompt', 'key', 'model')).rejects.toThrow('empty or unexpected');
    });

    test('throws on HTTP error', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => 'Forbidden'
        });

        await expect(callGemini('prompt', 'key', 'model')).rejects.toThrow('Gemini Error: 403');
    });
});

describe('callGroq', () => {
    test('returns trimmed response on success', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '  Groq answer  ' } }]
            })
        });

        const result = await callGroq('prompt', 'groq-key', 'llama-3.3-70b-versatile');
        expect(result).toBe('Groq answer');
    });

    test('throws if no API key provided', async () => {
        await expect(callGroq('prompt', '')).rejects.toThrow('API key not configured');
    });

    test('sends Authorization header', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'answer' } }]
            })
        });

        await callGroq('prompt', 'my-secret-key', 'model');
        expect(fetch).toHaveBeenCalledWith(
            GROQ_API_BASE,
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Authorization': 'Bearer my-secret-key'
                })
            })
        );
    });

    test('throws on empty response', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [] })
        });

        await expect(callGroq('prompt', 'key', 'model')).rejects.toThrow('empty or unexpected');
    });

    test('throws on HTTP error', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            text: async () => 'Rate limited'
        });

        await expect(callGroq('prompt', 'key', 'model')).rejects.toThrow('Groq Error: 429');
    });
});

describe('callLLMByProvider', () => {
    test('dispatches to Ollama by default', async () => {
        chrome.storage.local.get.mockImplementation((keys, cb) => {
            // Return a promise for the async version
            return Promise.resolve({ provider: 'ollama', apiUrl: 'http://localhost:11434/api/generate', modelName: 'llama3' });
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: 'ollama result' })
        });

        const result = await callLLMByProvider('test prompt');
        expect(result).toBe('ollama result');
    });

    test('dispatches to Gemini when configured', async () => {
        chrome.storage.local.get.mockResolvedValue({
            provider: 'gemini',
            geminiApiKey: 'test-key',
            geminiModel: 'gemma-3-27b-it'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'gemini result' }] } }]
            })
        });

        const result = await callLLMByProvider('test prompt');
        expect(result).toBe('gemini result');
    });

    test('dispatches to Groq when configured', async () => {
        chrome.storage.local.get.mockResolvedValue({
            provider: 'groq',
            groqApiKey: 'groq-key',
            groqModel: 'llama-3.3-70b-versatile'
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'groq result' } }]
            })
        });

        const result = await callLLMByProvider('test prompt');
        expect(result).toBe('groq result');
    });
});

describe('callLLM', () => {
    test('builds prompt from template and calls provider', async () => {
        chrome.storage.local.get.mockResolvedValue({ provider: 'ollama' });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: '❓ Question?\n💡 Answer.' })
        });

        const result = await callLLM('article text here', 'Test Headline');
        expect(result).toBe('❓ Question?\n💡 Answer.');

        // Verify the prompt was built correctly
        const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
        expect(sentBody.prompt).toContain('Test Headline');
        expect(sentBody.prompt).toContain('article text here');
    });

    test('injects language instruction into prompt for English content', async () => {
        chrome.storage.local.get.mockResolvedValue({ provider: 'ollama' });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: '❓ Q?\n💡 A.' })
        });

        await callLLM('English article text about something important', 'Breaking News: Something Happened');

        const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
        expect(sentBody.prompt).toContain('MUST respond in English');
    });

    test('injects Hebrew language instruction for Hebrew content', async () => {
        chrome.storage.local.get.mockResolvedValue({ provider: 'ollama' });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: '❓ שאלה?\n💡 תשובה.' })
        });

        await callLLM('טקסט של כתבה בעברית', 'כותרת בעברית');

        const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
        expect(sentBody.prompt).toContain('MUST respond in Hebrew');
    });
});

describe('detectLanguage', () => {
    test('detects English text', () => {
        expect(detectLanguage('Breaking News', 'The president announced a new policy today')).toBe('English');
    });

    test('detects Hebrew text', () => {
        expect(detectLanguage('כותרת בעברית', 'טקסט של כתבה בעברית')).toBe('Hebrew');
    });

    test('detects Arabic text', () => {
        expect(detectLanguage('عنوان بالعربية', 'نص المقال بالعربية')).toBe('Arabic');
    });

    test('returns English for empty input', () => {
        expect(detectLanguage('', '')).toBe('English');
    });

    test('uses headline language when article is mixed', () => {
        // Hebrew headline with some English in article
        expect(detectLanguage('כותרת בעברית', 'some english text but also הרבה טקסט בעברית שמכריע את המאזן')).toBe('Hebrew');
    });

    test('detects English even with numbers/symbols', () => {
        expect(detectLanguage('Top 10 Things!', 'Here are the top 10 things you need to know: #1, #2...')).toBe('English');
    });

    test('detects English for LADbible-style headlines', () => {
        expect(detectLanguage("You Won't Believe What Happened Next", 'A man from London did something extraordinary...')).toBe('English');
    });
});
