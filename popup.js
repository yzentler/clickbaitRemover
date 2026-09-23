// popup.js
document.addEventListener('DOMContentLoaded', () => {
    // Elements - Common
    const providerSelect = document.getElementById('providerSelect');
    const saveBtn = document.getElementById('saveBtn');
    const testBtn = document.getElementById('testBtn');
    const status = document.getElementById('status');
    const errorHelp = document.getElementById('errorHelp');

    // Elements - Ollama
    const ollamaSection = document.getElementById('ollamaSection');
    const apiUrlInput = document.getElementById('apiUrl');
    const modelSelect = document.getElementById('modelSelect');
    const refreshModelsBtn = document.getElementById('refreshModelsBtn');
    const ollamaErrorHelp = document.getElementById('ollamaErrorHelp');

    // Elements - Gemini
    const geminiSection = document.getElementById('geminiSection');
    const geminiApiKeyInput = document.getElementById('geminiApiKey');
    const geminiModelSelect = document.getElementById('geminiModelSelect');
    const refreshGeminiModelsBtn = document.getElementById('refreshGeminiModelsBtn');
    const geminiErrorHelp = document.getElementById('geminiErrorHelp');

    // Elements - Groq
    const groqSection = document.getElementById('groqSection');
    const groqApiKeyInput = document.getElementById('groqApiKey');
    const groqModelSelect = document.getElementById('groqModelSelect');
    const groqErrorHelp = document.getElementById('groqErrorHelp');

    // Elements - Chrome Built-in AI
    const chromeAiSection = document.getElementById('chromeAiSection');
    const chromeAiStatus = document.getElementById('chromeAiStatus');

    // Elements - General Settings
    const showTimingToggle = document.getElementById('showTimingToggle');

    // --- Helpers ---
    const getBaseUrl = () => {
        let url = apiUrlInput.value.trim().replace(/\/api\/generate\/?$/, '');
        return url.endsWith('/') ? url : `${url}/`;
    };

    const setStatus = (msg, type = 'info') => {
        status.textContent = msg;
        status.style.color = type === 'error' ? 'red' : (type === 'success' ? 'green' : 'blue');

        const provider = providerSelect.value;

        if (type === 'error') {
            errorHelp.style.display = 'block';
            ollamaErrorHelp.style.display = provider === 'ollama' ? 'block' : 'none';
            geminiErrorHelp.style.display = provider === 'gemini' ? 'block' : 'none';
            groqErrorHelp.style.display = provider === 'groq' ? 'block' : 'none';
        } else {
            errorHelp.style.display = 'none';
        }
    };

    const checkChromeAiStatus = async () => {
        const ai = (typeof self !== 'undefined' && self.ai) ? self.ai : ((typeof window !== 'undefined') ? window.ai : null);
        if (!ai?.languageModel) {
            chromeAiStatus.textContent = '⚠️ Chrome Built-in AI not detected. Requires Chrome 148+ with Gemini Nano.';
            chromeAiStatus.style.color = '#856404';
            return;
        }
        try {
            const availability = await ai.languageModel.availability();
            if (availability === 'readily' || availability === 'available') {
                chromeAiStatus.textContent = '✅ Gemini Nano is ready for on-device inference!';
                chromeAiStatus.style.color = 'green';
            } else {
                chromeAiStatus.textContent = `ℹ️ Status: ${availability}. Model may be downloading.`;
                chromeAiStatus.style.color = '#856404';
            }
        } catch (e) {
            chromeAiStatus.textContent = `⚠️ Error checking status: ${e.message}`;
            chromeAiStatus.style.color = 'red';
        }
    };

    // --- Provider Toggle ---
    const toggleProviderUI = (provider) => {
        ollamaSection.style.display = provider === 'ollama' ? 'block' : 'none';
        geminiSection.style.display = provider === 'gemini' ? 'block' : 'none';
        groqSection.style.display = provider === 'groq' ? 'block' : 'none';
        if (chromeAiSection) {
            chromeAiSection.style.display = provider === 'chrome-ai' ? 'block' : 'none';
            if (provider === 'chrome-ai') checkChromeAiStatus();
        }
        errorHelp.style.display = 'none';
        status.textContent = '';
    };

    providerSelect.addEventListener('change', () => {
        toggleProviderUI(providerSelect.value);
    });

    // --- Ollama API Calls ---
    async function testOllama(apiUrl, modelName) {
        const url = `${apiUrl}api/generate`;
        const payload = {
            model: modelName,
            prompt: "Say hello",
            stream: false
        };

        console.log(`[Popup] Testing Ollama connection to ${url} with model ${modelName}`);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            console.log(`[Popup] Ollama response status: ${response.status}`);
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const data = await response.json();
            console.log(`[Popup] Ollama connection successful. Response:`, data);
            return data.response ? "Success: " + data.response : "Connected, but empty response.";
        } catch (e) {
            console.error(`[Popup] Ollama connection failed:`, e);
            throw new Error(`Ollama Error: ${e.message}`);
        }
    }

    const fetchOllamaModels = async (silent = false) => {
        const baseUrl = getBaseUrl();
        const tagsUrl = `${baseUrl}api/tags`;

        if (!silent) {
            modelSelect.innerHTML = '<option value="" disabled selected>Loading...</option>';
            modelSelect.disabled = true;
            errorHelp.style.display = 'none';
        }

        try {
            const response = await fetch(tagsUrl);
            if (!response.ok) throw new Error(`Status ${response.status}`);

            const data = await response.json();
            const models = data.models || [];

            modelSelect.innerHTML = '';
            if (models.length === 0) {
                modelSelect.add(new Option("No models found", ""));
            } else {
                models.forEach(m => modelSelect.add(new Option(m.name, m.name)));
            }
            modelSelect.disabled = false;

            chrome.storage.local.get(['modelName'], (res) => {
                if (res.modelName && models.some(m => m.name === res.modelName)) {
                    modelSelect.value = res.modelName;
                }
            });
            return true;
        } catch (e) {
            console.error(e);
            modelSelect.innerHTML = '<option value="" disabled selected>Connection Failed</option>';
            modelSelect.disabled = true;
            if (!silent) setStatus('Could not connect to Ollama.', 'error');
            return false;
        }
    };

    // --- Gemini API Calls ---
    const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

    async function testGemini(apiKey, modelName) {
        let model = modelName || 'gemini-2.5-flash';
        if (model.includes('latest')) {
            model = 'gemini-2.5-flash';
        }
        const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
        const payload = {
            contents: [{ parts: [{ text: "Say hello in Hebrew, one word only" }] }]
        };

        console.log(`[Popup] Testing Gemini connection with model ${model}`);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            console.log(`[Popup] Gemini response status: ${response.status}`);

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const errMsg = errData.error?.message || `${response.status} ${response.statusText}`;
                throw new Error(errMsg);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "(empty response)";
            console.log(`[Popup] Gemini connection successful. Response: ${text}`);
            return "Success: " + text.trim();
        } catch (e) {
            console.error(`[Popup] Gemini connection failed:`, e);
            throw new Error(`Gemini Error: ${e.message}`);
        }
    }

    const fetchGeminiModels = async (silent = false) => {
        const apiKey = geminiApiKeyInput.value.trim();
        if (!apiKey) {
            if (!silent) setStatus('Enter your Gemini API key first.', 'error');
            return false;
        }

        if (!silent) {
            geminiModelSelect.innerHTML = '<option value="" disabled selected>Loading...</option>';
            geminiModelSelect.disabled = true;
            errorHelp.style.display = 'none';
        }

        try {
            const url = `${GEMINI_API_BASE}/models?key=${apiKey}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Status ${response.status}`);

            const data = await response.json();
            const models = (data.models || [])
                .filter(m =>
                    m.supportedGenerationMethods &&
                    m.supportedGenerationMethods.includes("generateContent")
                )
                .map(m => ({
                    id: m.name.replace('models/', ''),
                    displayName: m.displayName
                }))
                .sort((a, b) => a.displayName.localeCompare(b.displayName));

            geminiModelSelect.innerHTML = '';
            if (models.length === 0) {
                geminiModelSelect.add(new Option("No models found", ""));
            } else {
                models.forEach(m => geminiModelSelect.add(new Option(m.displayName, m.id)));
            }
            geminiModelSelect.disabled = false;

            // Restore saved selection or default to gemini-2.5-flash
            chrome.storage.local.get(['geminiModel'], (res) => {
                let savedModel = res.geminiModel;
                if (!savedModel || savedModel.includes('latest')) {
                    savedModel = 'gemini-2.5-flash';
                }
                if (models.some(m => m.id === savedModel)) {
                    geminiModelSelect.value = savedModel;
                } else if (models.some(m => m.id === 'gemini-2.5-flash')) {
                    geminiModelSelect.value = 'gemini-2.5-flash';
                } else if (models.length > 0) {
                    geminiModelSelect.value = models[0].id;
                }
            });

            if (!silent) setStatus(`Loaded ${models.length} models.`, 'success');
            return true;
        } catch (e) {
            console.error('[Popup] Failed to fetch Gemini models:', e);
            geminiModelSelect.innerHTML = '<option value="" disabled selected>Fetch Failed</option>';
            geminiModelSelect.disabled = true;
            if (!silent) setStatus('Could not fetch Gemini models. Check your API key.', 'error');
            return false;
        }
    };

    // --- Groq API Calls ---
    const GROQ_API_BASE = "https://api.groq.com/openai/v1";

    async function testGroq(apiKey, modelName) {
        const model = modelName || 'llama-3.3-70b-versatile';
        const url = `${GROQ_API_BASE}/chat/completions`;
        const payload = {
            model: model,
            messages: [{ role: "user", content: "Say hello in Hebrew, one word only" }],
            max_tokens: 20
        };

        console.log(`[Popup] Testing Groq connection with model ${model}`);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            console.log(`[Popup] Groq response status: ${response.status}`);

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const errMsg = errData.error?.message || `${response.status} ${response.statusText}`;
                throw new Error(errMsg);
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || "(empty response)";
            console.log(`[Popup] Groq connection successful. Response: ${text}`);
            return "Success: " + text.trim();
        } catch (e) {
            console.error(`[Popup] Groq connection failed:`, e);
            throw new Error(`Groq Error: ${e.message}`);
        }
    }

    // --- Init: Load saved settings ---
    chrome.storage.local.get(['provider', 'apiUrl', 'modelName', 'geminiApiKey', 'geminiModel', 'groqApiKey', 'groqModel', 'showTiming'], (result) => {
        // Provider
        const provider = result.provider || 'ollama';
        providerSelect.value = provider;
        toggleProviderUI(provider);

        // Ollama
        if (result.apiUrl) {
            let displayUrl = result.apiUrl.replace('/api/generate', '');
            apiUrlInput.value = displayUrl || 'http://localhost:11434';
        }

        // Gemini
        if (result.geminiApiKey) {
            geminiApiKeyInput.value = result.geminiApiKey;
        }
        if (result.geminiModel) {
            let modelToUse = result.geminiModel;
            if (modelToUse.includes('latest')) {
                modelToUse = 'gemini-2.5-flash';
                chrome.storage.local.set({ geminiModel: 'gemini-2.5-flash' });
            }
            const opts = geminiModelSelect.options;
            let matched = false;
            for (let i = 0; i < opts.length; i++) {
                if (opts[i].value === modelToUse) {
                    geminiModelSelect.value = modelToUse;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                // If stored model is not in the hardcoded list (e.g. from an API fetch or older version),
                // add it dynamically so the UI accurately shows what is saved in storage.
                const opt = new Option(`${modelToUse} (Saved)`, modelToUse);
                geminiModelSelect.add(opt);
                geminiModelSelect.value = modelToUse;
            }
        }

        // Groq
        if (result.groqApiKey) {
            groqApiKeyInput.value = result.groqApiKey;
        }
        if (result.groqModel) {
            const opts = groqModelSelect.options;
            let matched = false;
            for (let i = 0; i < opts.length; i++) {
                if (opts[i].value === result.groqModel) {
                    groqModelSelect.value = result.groqModel;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                const opt = new Option(`${result.groqModel} (Saved)`, result.groqModel);
                groqModelSelect.add(opt);
                groqModelSelect.value = result.groqModel;
            }
        }

        // Timing toggle (defaults to true if not set)
        showTimingToggle.checked = result.showTiming !== false;

        // Auto-load model lists for the active provider
        if (provider === 'ollama') {
            fetchOllamaModels(true);
        }
    });

    // --- Actions ---
    refreshModelsBtn.addEventListener('click', () => fetchOllamaModels());
    refreshGeminiModelsBtn.addEventListener('click', () => fetchGeminiModels());

    geminiModelSelect.addEventListener('change', () => {
        const geminiModel = geminiModelSelect.value;
        if (geminiModel) {
            chrome.storage.local.set({ geminiModel });
        }
    });

    groqModelSelect.addEventListener('change', () => {
        const groqModel = groqModelSelect.value;
        if (groqModel) {
            chrome.storage.local.set({ groqModel });
        }
    });

    modelSelect.addEventListener('change', () => {
        const modelName = modelSelect.value;
        if (modelName) {
            chrome.storage.local.set({ modelName });
        }
    });

    apiUrlInput.addEventListener('blur', () => {
        let val = apiUrlInput.value.trim();
        if (val && !val.startsWith('http')) {
            apiUrlInput.value = 'http://' + val;
        }
    });

    // Test Button
    testBtn.addEventListener('click', async () => {
        setStatus('Testing...', 'info');

        try {
            if (providerSelect.value === 'gemini') {
                const apiKey = geminiApiKeyInput.value.trim();
                const model = geminiModelSelect.value;
                if (!apiKey) {
                    setStatus('Enter your Gemini API key first.', 'error');
                    return;
                }
                const result = await testGemini(apiKey, model);
                setStatus('✅ ' + result.substring(0, 80), 'success');
            } else if (providerSelect.value === 'groq') {
                const apiKey = groqApiKeyInput.value.trim();
                const model = groqModelSelect.value;
                if (!apiKey) {
                    setStatus('Enter your Groq API key first.', 'error');
                    return;
                }
                const result = await testGroq(apiKey, model);
                setStatus('✅ ' + result.substring(0, 80), 'success');
            } else if (providerSelect.value === 'chrome-ai') {
                const ai = (typeof self !== 'undefined' && self.ai) ? self.ai : ((typeof window !== 'undefined') ? window.ai : null);
                if (!ai?.languageModel) throw new Error('Chrome Built-in AI not available');
                const session = await ai.languageModel.create();
                const result = await session.prompt("Say hello in Hebrew, one word only");
                setStatus('✅ ' + (result || 'Success!').substring(0, 80), 'success');
            } else {
                const model = modelSelect.value;
                if (!model) {
                    setStatus('Select a model first (or check connection).', 'error');
                    return;
                }
                const result = await testOllama(getBaseUrl(), model);
                setStatus('✅ ' + result.substring(0, 50) + '...', 'success');
            }
        } catch (e) {
            setStatus(e.message, 'error');
        }
    });

    // Save Button
    saveBtn.addEventListener('click', () => {
        const provider = providerSelect.value;

        if (provider === 'chrome-ai') {
            chrome.storage.local.set({ provider, showTiming: showTimingToggle.checked }, () => {
                setStatus('✅ Chrome Built-in AI settings saved!', 'success');
                setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 2000);
            });
        } else if (provider === 'gemini') {
            const apiKey = geminiApiKeyInput.value.trim();
            const geminiModel = geminiModelSelect.value;

            if (!apiKey) {
                setStatus('Please enter your Gemini API key.', 'error');
                return;
            }
            if (!geminiModel) {
                setStatus('Please select a Gemini model.', 'error');
                return;
            }

            chrome.storage.local.set({ provider, geminiApiKey: apiKey, geminiModel, showTiming: showTimingToggle.checked }, () => {
                setStatus('✅ Gemini settings saved!', 'success');
                setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 2000);
            });
        } else if (provider === 'groq') {
            const apiKey = groqApiKeyInput.value.trim();
            const groqModel = groqModelSelect.value;

            if (!apiKey) {
                setStatus('Please enter your Groq API key.', 'error');
                return;
            }

            chrome.storage.local.set({ provider, groqApiKey: apiKey, groqModel, showTiming: showTimingToggle.checked }, () => {
                setStatus('✅ Groq settings saved!', 'success');
                setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 2000);
            });
        } else {
            const baseUrl = getBaseUrl();
            const generateUrl = `${baseUrl}api/generate`;
            const modelName = modelSelect.value;

            if (!modelName) {
                setStatus('Please select an Ollama model.', 'error');
                return;
            }

            chrome.storage.local.set({ provider, apiUrl: generateUrl, modelName, showTiming: showTimingToggle.checked }, () => {
                setStatus('✅ Ollama settings saved!', 'success');
                setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 2000);
            });
        }
    });
});
