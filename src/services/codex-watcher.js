const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { calculateCostUsd } = require('./pricing');

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

async function walkJsonl(directory, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkJsonl(fullPath, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files;
}

class CodexWatcher extends EventEmitter {
  constructor({ sessionsDir, existingEvents = [], pollMs = 900 } = {}) {
    super();
    this.sessionsDir = sessionsDir || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    this.pollMs = pollMs;
    this.states = new Map();
    this.seenIds = new Set(existingEvents.map((event) => event.id).filter(Boolean));
    this.timer = null;
    this.stopped = false;
  }

  async start() {
    const initial = await this.poll({ replay: true });
    if (initial.length) this.emit('batch', { events: initial, replay: true });
    this.timer = setInterval(() => {
      this.poll({ replay: false })
        .then((events) => { if (events.length) this.emit('batch', { events, replay: false }); })
        .catch((error) => console.warn('Codex watcher poll failed:', error.message));
    }, this.pollMs);
    this.emit('ready', { sessionsDir: this.sessionsDir });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll({ replay }) {
    if (this.stopped) return [];
    const cutoff = Date.now() - 36 * 60 * 60 * 1000;
    const files = await walkJsonl(this.sessionsDir);
    const events = [];
    for (const file of files) {
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      if (!this.states.has(file)) {
        this.states.set(file, { offset: 0, remainder: '', model: 'codex' });
      }
      await this.readAppended(file, stat, this.states.get(file), replay, events);
    }
    return events;
  }

  async readAppended(file, stat, state, replay, output) {
    let offset = state.offset;
    if (stat.size < offset) {
      offset = 0;
      state.remainder = '';
      state.model = 'codex';
    }
    if (stat.size === offset) return;
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(file, 'r');
    try {
      await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }
    state.offset = stat.size;
    const text = state.remainder + buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    state.remainder = lines.pop() || '';
    for (const line of lines) {
      const event = this.parseLine(line, state, replay);
      if (event) output.push(event);
    }
  }

  parseLine(line, state, replay) {
    if (!line.trim()) return null;
    let record;
    try { record = JSON.parse(line); } catch { return null; }
    const payload = record.payload || {};
    if (record.type === 'turn_context' && payload.model) state.model = payload.model;
    if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      state.model = payload.thread_settings?.model || state.model;
    }
    if (record.type !== 'token_usage_record') return null;
    const usage = payload.usage || {};
    const timestamp = record.timestamp || new Date().toISOString();
    if (new Date(timestamp) < startOfToday()) return null;
    const id = payload.response_id
      ? `codex:${payload.response_id}`
      : `codex:${payload.thread_id || 'thread'}:${payload.turn_id || 'turn'}:${timestamp}`;
    if (this.seenIds.has(id)) return null;
    this.seenIds.add(id);
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;
    const cachedTokens = Number(usage.cached_input_tokens) || 0;
    const reasoningTokens = Number(usage.reasoning_output_tokens) || 0;
    const model = payload.model || state.model || 'codex';
    const priced = calculateCostUsd(model, { inputTokens, outputTokens, cachedTokens });
    return {
      id,
      timestamp,
      provider: 'codex',
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      costUsd: priced.costUsd,
      costKnown: priced.pricingKnown,
      latencyMs: 0,
      status: 200,
      stream: false,
      source: 'codex-local',
      estimated: !priced.pricingKnown,
      replay,
    };
  }
}

module.exports = { CodexWatcher };
