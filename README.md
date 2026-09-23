# Hebrew Clickbait Remover

A Chrome Extension that detects clickbait headlines on Hebrew news sites (currently supporting `israelhayom.co.il`) and provides AI-generated summaries on hover.

![Icon](https://github.com/user-attachments/assets/placeholder-icon.png)

## Features

- **Clickbait Detection**: Automatically identifies article links on supported news sites.
- **AI-Powered Summaries**: Uses a local LLM (via **Ollama**) to generate concise, factual summaries (under 10 words).
- **Privacy First**: All processing happens locally on your machine. No data is sent to external cloud servers.
- **Configurable**: Choose your preferred local LLM model (e.g., Llama 3, Mistral).

## Prerequisites

1.  **Google Chrome** or a Chromium-based browser.
2.  **Ollama** installed and running locally.
    -   Download from [ollama.com](https://ollama.com).

> [!IMPORTANT]
> **One-Time Configuration for macOS**
> To allow the extension to talk to Ollama without keeping a terminal open, run this command **once**:
>
> 1. Open Terminal.
> 2. Run:
>    ```bash
>    launchctl setenv OLLAMA_ORIGINS "*"
>    ```
> 3. **Restart Ollama**: Click the Ollama icon in the menu bar > Quit, then open it again from your Applications folder.
>
> *Note: You may need to re-run this command if you restart your computer, unless you add it to your startup config.*

## Installation

1.  Clone or download this repository to your local machine.
    ```bash
    git clone https://github.com/yourusername/clickbait-remover.git
    ```
2.  Open Chrome and navigate to `chrome://extensions`.
3.  Enable **Developer mode** in the top right corner.
4.  Click **Load unpacked**.
5.  Select the `clickbait-remover` folder from this repository.

## Configuration

1.  Click the extension icon in the Chrome toolbar.
2.  **API URL**: Enter your local Ollama API endpoint (default: `http://localhost:11434/api/generate`).
3.  **Model Name**: Select a model from the dropdown (ensure Ollama is running).
4.  Click **Save Settings**.

## Usage

1.  Ensure Ollama is running (the icon should be in your menu bar).
2.  Visit [Israel Hayom Sport](https://www.israelhayom.co.il/sport).
3.  Look for the small **robot icon** next to headlines.
4.  **Hover** over the icon to reveal the summary.

## Troubleshooting

-   **"Forbidden" / Network Error**:
    -   Did you run `launchctl setenv OLLAMA_ORIGINS "*"`?
    -   Did you **Quit and Restart** the Ollama app after running that command?
-   **No Summary**: Check the extension console (`chrome://extensions` > Details > Inspect views: service worker).

## License

MIT
