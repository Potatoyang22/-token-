const http = require('node:http');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { calculateCostUsd } = require('./pricing');

const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
]);

function collectBody(stream, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体超过 25MB 上限'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function textFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map((message) => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((part) => part?.text || '').join(' ');
    }
    return '';
  }).join('\n');
}

function estimateTokens(text) {
  const length = String(text || '').trim().length;
  return length ? Math.max(1, Math.ceil(length / 4)) : 0;
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens) || 0;
  const cachedTokens = Number(
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cachedTokens,
  ) || 0;
  const reasoningTokens = Number(
    usage.completion_tokens_details?.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? usage.reasoningTokens,
  ) || 0;
  return { inputTokens, outputTokens, cachedTokens, reasoningTokens };
}

function extractUsageFromSse(text) {
  let usage = null;
  let responseText = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const payload = JSON.parse(data);
      if (payload.usage) usage = { ...(usage || {}), ...payload.usage };
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') responseText += delta;
      const message = payload.choices?.[0]?.message?.content;
      if (typeof message === 'string') responseText += message;
      if (payload.output_text && typeof payload.output_text === 'string') responseText += payload.output_text;
    } catch {
      // Incomplete or provider-specific SSE frames are ignored.
    }
  }
  return { usage, responseText };
}

function extractResponseText(payload, rawText) {
  if (!payload) return rawText;
  const choice = payload.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload.output)) {
    return payload.output.flatMap((item) => item?.content || [])
      .map((item) => item?.text || '')
      .join('');
  }
  return rawText;
}

class ProxyService extends EventEmitter {
  constructor({ store, getApiKey }) {
    super();
    this.store = store;
    this.getApiKey = getApiKey;
    this.server = null;
    this.port = null;
    this.status = { running: false, port: null, error: null, startedAt: null };
  }

  getStatus() {
    return { ...this.status };
  }

  async start(preferredPort = 8787, attempt = 0) {
    if (this.server) return this.getStatus();
    const port = preferredPort + attempt;
    const server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        console.error('Proxy request failed:', error);
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end(JSON.stringify({ error: { message: error.message, type: 'whalemeter_proxy_error' } }));
      });
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      this.server = server;
      this.port = port;
      this.status = {
        running: true,
        port,
        error: null,
        startedAt: new Date().toISOString(),
        baseUrl: `http://127.0.0.1:${port}/v1`,
      };
      this.emit('status', this.getStatus());
      return this.getStatus();
    } catch (error) {
      if (error.code === 'EADDRINUSE' && attempt < 8) return this.start(preferredPort, attempt + 1);
      this.status = { running: false, port: null, error: error.message, startedAt: null };
      this.emit('status', this.getStatus());
      return this.getStatus();
    }
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
    this.status = { running: false, port: null, error: null, startedAt: null };
    this.emit('status', this.getStatus());
  }

  buildTarget(pathWithQuery) {
    const settings = this.store.getSettings();
    const base = String(settings.upstreamBaseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('还没有配置上游 Base URL');
    let suffix = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
    if (/\/v1$/i.test(base) && /^\/v1(?=\/|$)/i.test(suffix)) suffix = suffix.replace(/^\/v1/i, '') || '/';
    return `${base}${suffix}`;
  }

  async handleRequest(request, response) {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', '*');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.url === '/__whalemeter/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, proxy: this.getStatus() }));
      return;
    }

    if (!request.url?.startsWith('/v1/')) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'WhaleMeter proxy only accepts /v1/* requests' } }));
      return;
    }

    const startedAt = Date.now();
    const body = await collectBody(request);
    let requestJson = null;
    if (body.length) {
      try { requestJson = JSON.parse(body.toString('utf8')); } catch { /* Forward non-JSON bodies unchanged. */ }
    }
    const stream = Boolean(requestJson?.stream);
    const apiKey = await this.getApiKey();
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase()) && value != null) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (apiKey && !headers.authorization) headers.authorization = `Bearer ${apiKey}`;
    headers.accept = headers.accept || (stream ? 'text/event-stream' : 'application/json');

    const target = this.buildTarget(request.url);
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: body.length ? body : undefined,
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase()) && !['content-encoding', 'content-length'].includes(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    });
    responseHeaders['access-control-allow-origin'] = '*';
    response.writeHead(upstream.status, responseHeaders);

    let rawResponse = '';
    if (stream && upstream.body) {
      const webStream = Readable.fromWeb(upstream.body);
      for await (const chunk of webStream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rawResponse += buffer.toString('utf8');
        if (rawResponse.length > 5_000_000) rawResponse = rawResponse.slice(-5_000_000);
        response.write(buffer);
      }
      response.end();
    } else {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      rawResponse = buffer.toString('utf8');
      response.end(buffer);
    }

    const sse = extractUsageFromSse(rawResponse);
    let payload = null;
    try { payload = JSON.parse(rawResponse); } catch { /* SSE or non-JSON response. */ }
    let usage = normalizeUsage(payload?.usage || sse.usage || {});
    const model = requestJson?.model || payload?.model || 'unknown';
    const inputText = textFromMessages(requestJson?.messages || requestJson?.input);
    const outputText = extractResponseText(payload, sse.responseText || rawResponse);
    let estimated = false;
    if (!usage.inputTokens && !usage.outputTokens) {
      usage = {
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens(outputText),
        cachedTokens: 0,
        reasoningTokens: 0,
      };
      estimated = true;
    }
    const priced = calculateCostUsd(model, usage);
    const event = {
      timestamp: new Date().toISOString(),
      provider: this.store.getSettings().provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      costUsd: priced.costUsd,
      costKnown: priced.pricingKnown,
      latencyMs: Date.now() - startedAt,
      status: upstream.status,
      stream,
      source: 'proxy',
      estimated: estimated || priced.estimatedPricing,
    };
    if (upstream.ok) this.emit('usage', event);
  }
}

module.exports = { ProxyService, normalizeUsage, estimateTokens };

