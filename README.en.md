# WhaleMeter · Big Fat Whale 🐳

[简体中文](README.md) | **English**

A local-first desktop widget for monitoring LLM token usage, account balance, and estimated spend. The widget keeps only the blue whale from the original artwork, with balance details in a small speech bubble and live usage shown as bubbles blown by the whale. The full dashboard follows the information hierarchy of Token Monitor.

![WhaleMeter widget](docs/preview.png)

## Download

Download the Windows installer from [GitHub Releases](https://github.com/Potatoyang22/-token-/releases).

The current installer is unsigned, so Windows SmartScreen may show an unknown-publisher warning.

## Widget Mode

- Only the transparent whale widget is shown at launch; the full dashboard stays in the background
- No large blue card or full-screen panel is used for the widget
- The widget stays above Codex and other foreground windows
- Drag it anywhere; it has no taskbar entry and does not steal keyboard focus
- Codex local session logs are watched by default, so the widget appears automatically after real usage
- OpenAI-compatible requests passing through the optional local proxy also trigger updates
- Local monitoring never calls a model and never consumes extra tokens
- Each real usage record produces a whale bubble. It shows estimated spend when pricing is known, otherwise the measured token count
- A real balance decrease produces an additional balance-deduction bubble
- Rapid updates are coalesced, and at most four bubbles are kept on screen
- Click the arrow to open the full dashboard; a hidden widget returns on the next real usage
- Auto-show behavior can be disabled in Settings

## Data Sources

- Codex local watcher: reads `token_usage_record` entries from `~/.codex/sessions/**/*.jsonl`
- Local proxy: reads the `usage` object from OpenAI-compatible responses
- Balance providers: balance endpoints are queried only; no model request is made
- If no API key is saved in WhaleMeter, DeepSeek balance checks may reuse `OPENAI_API_KEY` from `~/.codex/auth.json`. The key is read in memory and is not copied into the widget configuration
- Daily spend is derived from the first successfully synced balance of the day and subsequent real balance decreases
- The widget does not display demo balances. Without a configured balance endpoint it shows `—`
- When the current model has no known price, the interface shows “Price unknown” instead of inventing a value

## Features

- DeepSeek balance via `GET /user/balance`
- OpenRouter credits via `GET /api/v1/credits`
- Custom JSON balance endpoints with configurable field paths
- Local OpenAI-compatible proxy at `http://127.0.0.1:8787/v1`
- Reads usage from regular responses and SSE streams
- Falls back to character-based token estimation and marks the result as `est.`
- Dashboard for today’s usage, input/output tokens, cache hits, latency, model mix, and live requests
- API keys entered in the app are encrypted through Electron `safeStorage`
- System tray entry, periodic balance refresh, and whale branding

## Run From Source

```powershell
git clone https://github.com/Potatoyang22/-token-.git
cd ./-token-
npm install
npm start
```

At first launch, WhaleMeter reads local Codex usage and attempts to reuse the local Codex DeepSeek credential for balance checks. Open the full dashboard from the widget to configure another provider.

## OpenAI-Compatible Proxy

Point an OpenAI-compatible client at:

```text
http://127.0.0.1:8787/v1
```

Example:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="placeholder",  # WhaleMeter uses the real key from its settings
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}],
)
```

The proxy listens on `127.0.0.1` only. Requests are forwarded to the upstream Base URL configured in WhaleMeter. Prompts and response bodies are not saved; only usage metadata is stored.

## Data and Security

- Application settings and usage events are stored in Electron’s local `userData` directory
- API keys are protected with operating-system credential storage
- Balances come from provider endpoints; the provider’s billing statement remains authoritative
- Estimated spend uses token counts and a local pricing table and may differ from the final bill
- Custom balance endpoints must return JSON; example field path: `data.balance`
- Local Codex session content is read-only and is not uploaded
- The application contains no analytics or telemetry

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the full security model.

## Development Checks

```powershell
npm run check
npm run capture
```

Screenshots are written to `screenshots/`.

## Design and License

The UI language is inspired by [Token Monitor](https://github.com/Javis603/token-monitor) (MIT). WhaleMeter source code is released under the MIT License. The whale artwork is used as the project’s brand asset with the owner’s permission.
