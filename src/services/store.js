const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({
  provider: 'deepseek',
  upstreamBaseUrl: 'https://api.deepseek.com',
  balanceUrl: '',
  customBalancePath: 'data.balance',
  currency: 'CNY',
  pollIntervalSeconds: 60,
  proxyPort: 8787,
  demoMode: false,
  watchCodex: true,
  schemaVersion: 2,
  autoShowWidget: true,
  widgetPosition: null,
  apiKeyCipher: '',
  updatedAt: null,
});

class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.eventsPath = path.join(dataDir, 'events.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.events = [];
    this.writeQueue = Promise.resolve();
    this.eventsWriteTimer = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.readJson(this.settingsPath, {})) };
    if (Number(this.settings.schemaVersion) < 2) {
      this.settings.demoMode = false;
      this.settings.watchCodex = true;
      this.settings.schemaVersion = 2;
      await this.queueWrite(this.settingsPath, this.settings);
    }
    const stored = await this.readJson(this.eventsPath, { events: [] });
    this.events = Array.isArray(stored.events) ? stored.events.slice(-5000) : [];
  }

  async readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      console.warn(`Could not read ${file}:`, error.message);
      return fallback;
    }
  }

  queueWrite(file, value) {
    this.writeQueue = this.writeQueue.then(async () => {
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(temp, file);
    }).catch((error) => console.error(`Could not write ${file}:`, error));
    return this.writeQueue;
  }

  getSettings() {
    return { ...this.settings };
  }

  getPublicSettings() {
    const { apiKeyCipher, ...safe } = this.settings;
    return { ...safe, hasApiKey: Boolean(apiKeyCipher) };
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch, updatedAt: new Date().toISOString() };
    await this.queueWrite(this.settingsPath, this.settings);
    return this.getPublicSettings();
  }

  async setApiKeyCipher(apiKeyCipher) {
    this.settings.apiKeyCipher = apiKeyCipher || '';
    this.settings.updatedAt = new Date().toISOString();
    await this.queueWrite(this.settingsPath, this.settings);
  }

  getEvents() {
    return this.events.slice();
  }

  addEvent(event) {
    const complete = {
      id: event.id || crypto.randomUUID(),
      timestamp: event.timestamp || new Date().toISOString(),
      provider: event.provider || this.settings.provider,
      model: event.model || 'unknown',
      inputTokens: Number(event.inputTokens) || 0,
      outputTokens: Number(event.outputTokens) || 0,
      cachedTokens: Number(event.cachedTokens) || 0,
      reasoningTokens: Number(event.reasoningTokens) || 0,
      costUsd: Number(event.costUsd) || 0,
      costKnown: event.costKnown === true ? true : event.costKnown === false ? false : undefined,
      latencyMs: Number(event.latencyMs) || 0,
      status: Number(event.status) || 200,
      stream: Boolean(event.stream),
      source: event.source || 'proxy',
      estimated: Boolean(event.estimated),
    };
    if (complete.id) {
      const existing = this.events.find((item) => item.id === complete.id);
      if (existing) return existing;
    }
    this.events.push(complete);
    this.events = this.events.slice(-5000);
    this.scheduleEventsWrite();
    return complete;
  }

  scheduleEventsWrite() {
    if (this.eventsWriteTimer) clearTimeout(this.eventsWriteTimer);
    this.eventsWriteTimer = setTimeout(() => {
      this.eventsWriteTimer = null;
      this.queueWrite(this.eventsPath, { events: this.events });
    }, 250);
  }

  async flush() {
    if (this.eventsWriteTimer) {
      clearTimeout(this.eventsWriteTimer);
      this.eventsWriteTimer = null;
      await this.queueWrite(this.eventsPath, { events: this.events });
    }
    await this.writeQueue;
  }

  async clearEvents() {
    if (this.eventsWriteTimer) {
      clearTimeout(this.eventsWriteTimer);
      this.eventsWriteTimer = null;
    }
    this.events = [];
    await this.queueWrite(this.eventsPath, { events: [] });
  }
}

module.exports = { JsonStore, DEFAULT_SETTINGS };


