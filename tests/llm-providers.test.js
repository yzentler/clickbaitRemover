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
    callOllama, callGemini, callGroq, callChromeAI,
    callLLM, callBatchLLM, callLLMByProvider, detectLanguage,
    GEMINI_API_BASE, DEFAULT_GEMINI_MODEL,
    GROQ_API_BASE, DEFAULT_GROQ_MODEL,
    DEFAULT_OLLAMA_URL, DEFAULT_OLLAMA_MODEL
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
                body: expect.stringContaining(`"model":"${DEFAULT_OLLAMA_MODEL}"`)
            })
        );
        expect(DEFAULT_OLLAMA_MODEL).toBe('qwen2.5:3b');
    });

    test('supports streaming with onChunk callback', async () => {
        const streamChunks = [
            JSON.stringify({ response: 'Part 1 ' }) + '\n',
            JSON.stringify({ response: 'Part 2' }) + '\n'
        ];
        const encoder = new TextEncoder();
        let idx = 0;
        const mockStream = new ReadableStream({
            pull(controller) {
                if (idx < streamChunks.length) {
                    controller.enqueue(encoder.encode(streamChunks[idx++]));
                } else {
                    controller.close();
                }
            }
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: mockStream
        });

        const chunksReceived = [];
        const onChunk = jest.fn((chunk, accumulated) => {
            chunksReceived.push(chunk);
        });

        const result = await callOllama('prompt', undefined, undefined, onChunk);
        expect(result).toBe('Part 1 Part 2');
        expect(onChunk).toHaveBeenCalledTimes(2);
        expect(chunksReceived).toEqual(['Part 1 ', 'Part 2']);
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
        expect(DEFAULT_GEMINI_MODEL).toBe('gemini-2.5-flash');
    });

    test('forms correct URL with ?key= for non-streaming calls', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'response' }] } }]
            })
        });

        await callGemini('prompt', 'test-key', 'gemini-2.5-flash');
        expect(fetch).toHaveBeenCalledWith(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test-key',
            expect.anything()
        );
    });

    test('retries with default model on 404 error from invalid model', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                text: async () => 'models/invalid-model is not found'
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: 'recovered response' }] } }]
                })
            });

        const result = await callGemini('prompt', 'test-key', 'invalid-model');
        expect(result).toBe('recovered response');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toContain(DEFAULT_GEMINI_MODEL);
    });

    test('supports streaming with onChunk callback for Gemini', async () => {
        const sseLines = [
            'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"stream"}]}}]}\n\n'
        ];
        const encoder = new TextEncoder();
        let idx = 0;
        const mockStream = new ReadableStream({
            pull(controller) {
                if (idx < sseLines.length) {
                    controller.enqueue(encoder.encode(sseLines[idx++]));
                } else {
                    controller.close();
                }
            }
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: mockStream
        });

        const chunksReceived = [];
        const onChunk = jest.fn((chunk) => chunksReceived.push(chunk));

        const result = await callGemini('prompt', 'test-key', undefined, onChunk);
        expect(result).toBe('Gemini stream');
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('streamGenerateContent?alt=sse'),
            expect.anything()
        );
        expect(chunksReceived).toEqual(['Gemini ', 'stream']);
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

    test('uses default SOTA model when not provided', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'answer' } }]
            })
        });

        await callGroq('prompt', 'groq-key');
        expect(fetch).toHaveBeenCalledWith(
            GROQ_API_BASE,
            expect.objectContaining({
                body: expect.stringContaining(`"model":"${DEFAULT_GROQ_MODEL}"`)
            })
        );
        expect(DEFAULT_GROQ_MODEL).toBe('llama-3.1-8b-instant');
    });

    test('supports streaming with onChunk callback for Groq', async () => {
        const sseLines = [
            'data: {"choices":[{"delta":{"content":"Groq "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"stream"}}]}\n\n',
            'data: [DONE]\n\n'
        ];
        const encoder = new TextEncoder();
        let idx = 0;
        const mockStream = new ReadableStream({
            pull(controller) {
                if (idx < sseLines.length) {
                    controller.enqueue(encoder.encode(sseLines[idx++]));
                } else {
                    controller.close();
                }
            }
        });

        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: mockStream
        });

        const chunksReceived = [];
        const onChunk = jest.fn((chunk) => chunksReceived.push(chunk));

        const result = await callGroq('prompt', 'groq-key', undefined, onChunk);
        expect(result).toBe('Groq stream');
        expect(fetch).toHaveBeenCalledWith(
            GROQ_API_BASE,
            expect.objectContaining({
                body: expect.stringContaining('"stream":true')
            })
        );
        expect(chunksReceived).toEqual(['Groq ', 'stream']);
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

describe('callChromeAI', () => {
    test('calls self.ai.languageModel session when available', async () => {
        const mockPromptStreaming = jest.fn().mockImplementation(() => {
            const encoder = new TextEncoder();
            const chunks = ['Chrome ', 'AI result'];
            let idx = 0;
            return new ReadableStream({
                pull(controller) {
                    if (idx < chunks.length) {
                        controller.enqueue(chunks[idx++]);
                    } else {
                        controller.close();
                    }
                }
            });
        });

        global.self = {
            ai: {
                languageModel: {
                    availability: jest.fn().mockResolvedValue('readily'),
                    create: jest.fn().mockResolvedValue({
                        promptStreaming: mockPromptStreaming
                    })
                }
            }
        };

        const chunks = [];
        const onChunk = jest.fn((c) => chunks.push(c));
        const result = await callChromeAI('test prompt', onChunk);

        expect(result).toBe('Chrome AI result');
        expect(chunks).toEqual(['Chrome ', 'AI result']);
        expect(global.self.ai.languageModel.create).toHaveBeenCalled();
    });

    test('throws if self.ai.languageModel is unavailable', async () => {
        global.self = {
            ai: {
                languageModel: {
                    availability: jest.fn().mockResolvedValue('no')
                }
            }
        };

        await expect(callChromeAI('test')).rejects.toThrow('Chrome Built-in AI is not available');
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

    test('prioritizes article text language over headline', () => {
        expect(detectLanguage('Exclusive Sports Update', 'דימיטריס איטודיס מונה למאמן הפועל תל אביב ומחזיק בסמכויות בלעדיות')).toBe('Hebrew');
    });

    test('appends language directive at prompt end for Hebrew article', async () => {
        chrome.storage.local.get.mockResolvedValue({ provider: 'ollama' });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: '❓ שאלה?\n💡 תשובה.' })
        });

        await callLLM('טקסט הכתבה המלא בעברית עם פרטים רבים', 'English Headline');
        const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
        expect(sentBody.prompt).toContain('The article text above is in Hebrew');
    });
});

describe('callBatchLLM', () => {
    test('handles single article by delegating to callLLM', async () => {
        chrome.storage.local.get.mockResolvedValue({ provider: 'ollama' });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ response: '❓ שאלה?\n💡 תשובה.' })
        });

        const results = await callBatchLLM([{ headline: 'כותרת', text: 'תוכן הכתבה' }]);
        expect(results).toHaveLength(1);
        expect(results[0]).toContain('תשובה.');
    });

    test('bundles multiple articles and parses batch response', async () => {
        chrome.storage.local.get.mockResolvedValue({ provider: 'ollama' });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                response: '--- 1 ---\n❓ מה קרה 1?\n💡 תשובה 1\n\n--- 2 ---\n❓ מה קרה 2?\n💡 תשובה 2'
            })
        });

        const items = [
            { headline: 'כותרת 1', text: 'תוכן 1' },
            { headline: 'כותרת 2', text: 'תוכן 2' },
        ];
        const results = await callBatchLLM(items);
        expect(results).toHaveLength(2);
        expect(results[0]).toContain('תשובה 1');
        expect(results[1]).toContain('תשובה 2');
    });
});
