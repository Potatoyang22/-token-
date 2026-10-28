# Security Policy / 安全策略

## Supported Versions / 支持版本

| Version | Supported |
| --- | --- |
| `0.4.x` | ✅ |
| `< 0.4` | ❌ |

## Reporting a Vulnerability / 报告安全问题

**Please do not report security vulnerabilities through public GitHub issues.**
**请不要通过公开 Issue 报告安全漏洞。**

Use GitHub Private Vulnerability Reporting:

- [Report a vulnerability](https://github.com/Potatoyang22/-token-/security/advisories/new)
- Repository: `Potatoyang22/-token-`

If private reporting is unavailable, contact [@Potatoyang22](https://github.com/Potatoyang22) through GitHub and ask for a private reporting channel.

Please include:

- Affected WhaleMeter version
- Operating system and version
- A clear description of the issue and its impact
- Reproduction steps or a minimal proof of concept
- Relevant logs with API keys, tokens, cookies, and personal data removed

We aim to acknowledge reports within three business days. Please allow time for investigation and a coordinated fix before public disclosure.

## Security Model / 安全模型

WhaleMeter is designed as a local-first desktop application:

- Codex session files are opened read-only. Prompt and response contents are not uploaded.
- Monitoring reads existing local usage records and does not call a language model. It therefore does not consume additional model tokens.
- DeepSeek balance checks may reuse the local Codex credential from `~/.codex/auth.json`. The credential is read in memory for the balance request and is not copied into WhaleMeter settings.
- API keys entered directly in WhaleMeter are encrypted with Electron `safeStorage`, backed by the operating system credential protection.
- The optional OpenAI-compatible proxy listens on `127.0.0.1` only. Do not expose this port to a LAN, public interface, reverse proxy, or tunnel without adding authentication and transport security.
- Balance requests are sent only to the configured provider or custom balance endpoint.
- The application does not include analytics, telemetry, advertising, or remote prompt logging.
- Logs and usage metadata are stored locally in the Electron application data directory.

## Sensitive Data / 敏感数据

Never include the following in an Issue, pull request, screenshot, or security report:

- API keys
- OAuth tokens or cookies
- Raw Codex or Claude session files
- Full prompts or model responses
- Account identifiers that are not required to understand the issue
- Local paths containing personal information

Redact sensitive values before sharing logs.

## Scope / 范围

In scope:

- Electron main process and window isolation
- Local Codex session parsing
- Credential discovery and storage
- Balance provider adapters
- Local proxy request handling
- IPC boundaries
- Release packaging and update integrity

Out of scope:

- Vulnerabilities in OpenAI, DeepSeek, OpenRouter, or other third-party services
- Compromise of an already compromised local machine
- Social engineering
- Denial-of-service attacks requiring local administrator access
- Issues caused by publicly exposing the local proxy

## Safe Usage / 安全使用建议

- Download builds from the official GitHub Releases page.
- Verify the SHA-256 checksum published with each release.
- The current Windows installer is unsigned, so verify that the download comes from the official repository before running it.
- Rotate an API key immediately if it is accidentally exposed.
- Keep the proxy bound to `127.0.0.1` unless you have added authentication and TLS.
- Review local logs before attaching them to any public report.
