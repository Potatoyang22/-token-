const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, safeStorage, shell, screen,
} = require('electron');
const { JsonStore } = require('./services/store');
const { PROVIDER_PRESETS, fetchBalance, presetFor } = require('./services/providers');
const { ProxyService } = require('./services/proxy');
const { CodexWatcher } = require('./services/codex-watcher');
const { calculateCostUsd } = require('./services/pricing');

const APP_ID = 'com.ziyang.whalemeter';
const WIDGET_WIDTH = 430;
const WIDGET_HEIGHT = 280;
const USD_TO_CNY = 7.2;
const captureMode = process.argv.includes('--capture');
let mainWindow = null;
let widgetWindow = null;
let widgetReady = false;
let tray = null;
let store = null;
let proxy = null;
let codexWatcher = null;
let lastBalance = null;
let lastBalanceAttempt = 0;
let balanceTimer = null;
let isRefreshingBalance = false;
let positionSaveTimer = null;
let widgetUpdateTimer = null;
let topmostTimer = null;
let isQuitting = false;

app.setAppUserModelId(APP_ID);

function demoEvents() {
  const now = Date.now();
  const models = ['deepseek-chat', 'deepseek-reasoner', 'gpt-4.1-mini', 'claude-sonnet-4'];
  const rows = [];
  for (let index = 0; index < 26; index += 1) {
    const model = models[index % models.length];
    const inputTokens = 1800 + ((index * 791) % 8200);
    const outputTokens = 240 + ((index * 337) % 1800);
    const cachedTokens = index % 3 === 0 ? Math.floor(inputTokens * 0.3) : 0;
    const priced = calculateCostUsd(model, { inputTokens, outputTokens, cachedTokens });
    rows.push({
      id: `demo-${index}`,
      timestamp: new Date(now - (25 - index) * 11 * 60 * 1000).toISOString(),
      provider: 'demo',
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens: model.includes('reasoner') ? 320 + index * 13 : 0,
      costUsd: priced.costUsd,
      latencyMs: 640 + ((index * 257) % 2600),
      status: 200,
      stream: index % 4 !== 0,
      source: 'demo',
      estimated: false,
    });
  }
  return rows;
}

const DEMO_EVENTS = demoEvents();

function demoBalance() {
  return {
    provider: 'custom',
    providerName: 'Whale Pool',
    status: 'ok',
    currency: 'CNY',
    value: 128.42,
    granted: 8.42,
    toppedUp: 120,
    checkedAt: new Date().toISOString(),
    message: '演示余额 · 配置 API Key 后同步真实数据',
    demo: true,
  };
}

function displayEvents() {
  const realEvents = store.getEvents();
  return realEvents.length ? realEvents : (store.getSettings().demoMode ? DEMO_EVENTS : []);
}

function summarizeToday(events) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = events.filter((event) => new Date(event.timestamp) >= start);
  const summary = today.reduce((result, event) => {
    const costKnown = event.costKnown !== false && (event.costKnown === true || event.costUsd > 0);
    if (costKnown) result.costUsd += event.costUsd;
    else result.unknownCostEvents += 1;
    result.tokens += event.inputTokens + event.outputTokens;
    result.inputTokens += event.inputTokens;
    result.outputTokens += event.outputTokens;
    result.cachedTokens += event.cachedTokens;
    result.requests += 1;
    return result;
  }, { costUsd: 0, unknownCostEvents: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 });
  const latest = today.at(-1) || events.at(-1) || null;
  return {
    ...summary,
    latest: latest ? {
      model: latest.model,
      provider: latest.provider,
      source: latest.source,
      tokens: latest.inputTokens + latest.outputTokens,
      costUsd: latest.costUsd,
      costKnown: latest.costKnown === true || latest.costUsd > 0,
      timestamp: latest.timestamp,
      estimated: latest.estimated,
    } : null,
  };
}

function publicSnapshot() {
  const settings = store.getPublicSettings();
  return {
    settings,
    events: displayEvents(),
    balance: lastBalance || (settings.demoMode ? demoBalance() : null),
    providers: PROVIDER_PRESETS,
    proxy: proxy?.getStatus() || { running: false },
    version: app.getVersion(),
  };
}

function projectedBalance(balance, events) {
  if (!balance || balance.value == null || !Number.isFinite(Number(balance.value))) return balance;
  const checkedAt = balance.checkedAt ? new Date(balance.checkedAt).getTime() : 0;
  const pendingUsd = events
    .filter((event) => new Date(event.timestamp).getTime() > checkedAt)
    .reduce((sum, event) => sum + (Number(event.costUsd) || 0), 0);
  const exchange = balance.currency === 'CNY' ? USD_TO_CNY : 1;
  const pendingSpend = pendingUsd * exchange;
  return {
    ...balance,
    value: Math.max(0, Number(balance.value) - pendingSpend),
    pendingSpend,
    projected: pendingSpend > 0.0000001,
  };
}

function widgetSnapshot() {
  const settings = store.getPublicSettings();
  const events = store.getEvents();
  const baseBalance = lastBalance && !lastBalance.demo ? lastBalance : null;
  return {
    settings: {
      provider: settings.provider,
      currency: settings.currency,
      demoMode: settings.demoMode,
      autoShowWidget: settings.autoShowWidget,
      hasApiKey: settings.hasApiKey,
    },
    summary: summarizeToday(events),
    balance: projectedBalance(baseBalance, events),
    proxy: proxy?.getStatus() || { running: false },
    version: app.getVersion(),
  };
}

function sendToDashboard(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendToWidget(channel, payload) {
  if (widgetWindow && !widgetWindow.isDestroyed() && widgetReady) widgetWindow.webContents.send(channel, payload);
}

function scheduleWidgetUpdate() {
  if (widgetUpdateTimer) return;
  widgetUpdateTimer = setTimeout(() => {
    widgetUpdateTimer = null;
    sendToWidget('widget:update', widgetSnapshot());
  }, 45);
}

async function readCodexApiKey() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const auth = JSON.parse(await fs.promises.readFile(path.join(codexHome, 'auth.json'), 'utf8'));
    return typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY : '';
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read Codex API key:', error.message);
    return '';
  }
}

async function decryptApiKey() {
  const settings = store.getSettings();
  const { apiKeyCipher } = settings;
  if (apiKeyCipher) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const key = safeStorage.decryptString(Buffer.from(apiKeyCipher, 'base64'));
        if (key) return key;
      }
    } catch (error) {
      console.warn('Could not decrypt API key:', error.message);
    }
  }
  if (settings.provider === 'deepseek') return readCodexApiKey();
  return '';
}

async function refreshBalance({ announce = true } = {}) {
  if (isRefreshingBalance) return lastBalance;
  isRefreshingBalance = true;
  lastBalanceAttempt = Date.now();
  try {
    const settings = store.getSettings();
    if (settings.demoMode && !settings.apiKeyCipher) {
      lastBalance = demoBalance();
    } else {
      lastBalance = await fetchBalance({ settings, apiKey: await decryptApiKey() });
      if (lastBalance?.status === 'ok' && lastBalance.value != null) {
        const now = new Date();
        const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const baseline = settings.balanceBaseline;
        if (!baseline || baseline.date !== dayKey || baseline.currency !== lastBalance.currency) {
          await store.saveSettings({ balanceBaseline: { date: dayKey, currency: lastBalance.currency, value: lastBalance.value } });
          lastBalance.todaySpend = 0;
        } else {
          lastBalance.todaySpend = Math.max(0, Number(baseline.value) - Number(lastBalance.value));
        }
      }
    }
    if (announce) {
      sendToDashboard('balance:update', lastBalance);
      sendToWidget('widget:balance', widgetSnapshot().balance);
    }
    return lastBalance;
  } finally {
    isRefreshingBalance = false;
  }
}

async function maybeRefreshBalanceAfterUsage() {
  if (Date.now() - lastBalanceAttempt < 15_000) return;
  await refreshBalance({ announce: true });
}

function pinWidgetAboveApps() {
  if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return;
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  widgetWindow.moveTop();
}

function startTopmostGuard() {
  if (topmostTimer) clearInterval(topmostTimer);
  topmostTimer = setInterval(pinWidgetAboveApps, 1800);
}

function defaultWidgetBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: workArea.x + workArea.width - WIDGET_WIDTH - 18,
    y: workArea.y + workArea.height - WIDGET_HEIGHT - 18,
  };
}

function widgetBounds() {
  const saved = store.getSettings().widgetPosition;
  const fallback = defaultWidgetBounds();
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback;
  const display = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: WIDGET_WIDTH, height: WIDGET_HEIGHT });
  const area = display.workArea;
  return {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: Math.min(Math.max(saved.x, area.x), area.x + area.width - WIDGET_WIDTH),
    y: Math.min(Math.max(saved.y, area.y), area.y + area.height - WIDGET_HEIGHT),
  };
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow;
  const bounds = widgetBounds();
  widgetWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  widgetWindow.setAlwaysOnTop(true);
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetReady = false;
  widgetWindow.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widgetWindow.once('ready-to-show', () => {
    widgetReady = true;
    widgetWindow.setOpacity(1);
    widgetWindow.showInactive();
    pinWidgetAboveApps();
    sendToWidget('widget:snapshot', widgetSnapshot());
  });
  widgetWindow.on('show', pinWidgetAboveApps);
  widgetWindow.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
  if (widgetUpdateTimer) clearTimeout(widgetUpdateTimer);
  if (topmostTimer) clearInterval(topmostTimer);
    positionSaveTimer = setTimeout(async () => {
      positionSaveTimer = null;
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      const [x, y] = widgetWindow.getPosition();
      await store.saveSettings({ widgetPosition: { x, y } });
    }, 450);
  });
  widgetWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      widgetWindow.hide();
    }
  });
  widgetWindow.on('closed', () => { widgetWindow = null; widgetReady = false; });
  return widgetWindow;
}

function showWidget({ reveal = false } = {}) {
  const window = createWidgetWindow();
  if (!window || window.isDestroyed()) return;
  const revealOnce = () => {
    const wasVisible = window.isVisible();
    window.setOpacity(1);
    if (!wasVisible) {
      window.showInactive();
      pinWidgetAboveApps();
      sendToWidget('widget:reveal', { reveal });
    } else {
      pinWidgetAboveApps();
    }
  };
  if (!widgetReady) {
    window.once('ready-to-show', revealOnce);
  } else {
    revealOnce();
  }
}

function hideWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#070b16',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', async () => {
    if (captureMode) mainWindow.show();
    if (captureMode) {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          const targetDir = app.isPackaged
            ? path.join(app.getPath('pictures'), 'WhaleMeter')
            : path.join(__dirname, '..', 'screenshots');
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(targetDir, 'whalemeter.png'), image.toPNG());
        } catch (error) {
          console.error('Could not capture WhaleMeter screenshot:', error);
        } finally {
          app.quit();
        }
      }, 1800);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function openDashboard(section = '') {
  const window = createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (section) {
    const notify = () => sendToDashboard('dashboard:navigate', section);
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', notify);
    else notify();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('WhaleMeter · 鲸算');
  const menu = Menu.buildFromTemplate([
    { label: '显示鲸鱼挂件', click: () => showWidget({ reveal: false }) },
    { label: '打开完整面板', click: () => openDashboard() },
    { label: '刷新余额', click: () => refreshBalance({ announce: true }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWidget({ reveal: false }));
}

async function saveSettings(patch, apiKey, clearApiKey) {
  const allowed = {};
  for (const key of ['provider', 'upstreamBaseUrl', 'balanceUrl', 'customBalancePath', 'currency', 'pollIntervalSeconds', 'proxyPort', 'demoMode', 'autoShowWidget']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) allowed[key] = patch[key];
  }
  if (allowed.proxyPort) allowed.proxyPort = Math.min(65535, Math.max(1024, Number(allowed.proxyPort) || 8787));
  if (allowed.pollIntervalSeconds) allowed.pollIntervalSeconds = Math.min(3600, Math.max(15, Number(allowed.pollIntervalSeconds) || 60));
  if (allowed.provider) {
    const preset = presetFor(allowed.provider);
    if (!patch.upstreamBaseUrl && allowed.provider !== store.getSettings().provider) allowed.upstreamBaseUrl = preset.upstreamBaseUrl;
    if (!patch.currency && allowed.provider !== store.getSettings().provider) allowed.currency = preset.currency;
  }
  await store.saveSettings(allowed);
  if (clearApiKey) await store.setApiKeyCipher('');
  if (typeof apiKey === 'string' && apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，拒绝以明文保存 API Key');
    const cipher = safeStorage.encryptString(apiKey.trim()).toString('base64');
    await store.setApiKeyCipher(cipher);
    await store.saveSettings({ demoMode: false });
  }

  const oldPort = proxy.getStatus().port;
  if (proxy.getStatus().running && oldPort !== store.getSettings().proxyPort) {
    await proxy.stop();
    await proxy.start(store.getSettings().proxyPort);
  }
  scheduleBalanceTimer();
  await refreshBalance({ announce: true });
  const settings = store.getPublicSettings();
  sendToDashboard('settings:updated', settings);
  sendToWidget('widget:settings', settings);
  sendToWidget('widget:update', widgetSnapshot());
  return settings;
}

function scheduleBalanceTimer() {
  if (balanceTimer) clearInterval(balanceTimer);
  const seconds = store.getSettings().pollIntervalSeconds || 60;
  balanceTimer = setInterval(() => refreshBalance({ announce: true }), seconds * 1000);
}

app.whenReady().then(async () => {
  const dataDir = process.env.WHALEMETER_DATA_DIR
    || (captureMode ? fs.mkdtempSync(path.join(os.tmpdir(), 'whalemeter-capture-')) : app.getPath('userData'));
  store = new JsonStore(dataDir);
  await store.init();
  proxy = new ProxyService({ store, getApiKey: decryptApiKey });
  proxy.on('status', (status) => {
    sendToDashboard('proxy:status', status);
    sendToWidget('widget:proxy', status);
  });
  proxy.on('usage', (event) => {
    const saved = store.addEvent(event);
    sendToDashboard('usage:event', saved);
    scheduleWidgetUpdate();
    if (store.getSettings().autoShowWidget) showWidget({ reveal: true });
    maybeRefreshBalanceAfterUsage().catch((error) => console.warn(error));
  });
  await proxy.start(store.getSettings().proxyPort || 8787);
  await refreshBalance({ announce: false });
  if (store.getSettings().watchCodex !== false) {
    codexWatcher = new CodexWatcher({
      sessionsDir: process.env.WHALEMETER_CODEX_SESSIONS,
      existingEvents: store.getEvents(),
      pollMs: 900,
    });
    codexWatcher.on('batch', ({ events, replay }) => {
      for (const event of events) store.addEvent(event);
      if (!replay && events.length) {
        for (const event of events) sendToDashboard('usage:event', event);
        scheduleWidgetUpdate();
        if (store.getSettings().autoShowWidget) showWidget({ reveal: true });
        maybeRefreshBalanceAfterUsage().catch((error) => console.warn(error));
      }
    });
    await codexWatcher.start();
  }
  createMainWindow();
  createWidgetWindow();
  startTopmostGuard();
  createTray();
  scheduleBalanceTimer();

  ipcMain.handle('app:bootstrap', () => publicSnapshot());
  ipcMain.handle('widget:bootstrap', () => widgetSnapshot());
  ipcMain.handle('settings:save', (_event, payload) => saveSettings(payload.patch || {}, payload.apiKey, Boolean(payload.clearApiKey)));
  ipcMain.handle('balance:refresh', () => refreshBalance({ announce: true }));
  ipcMain.handle('events:clear', async () => {
    await store.clearEvents();
    sendToWidget('widget:update', widgetSnapshot());
    return true;
  });
  ipcMain.handle('proxy:status', () => proxy.getStatus());
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:open-dashboard', (_event, section) => openDashboard(section));
  ipcMain.handle('widget:hide', () => hideWidget());
  ipcMain.handle('widget:refresh-balance', () => refreshBalance({ announce: true }));
  ipcMain.handle('widget:open-dashboard', (_event, section) => openDashboard(section));
  ipcMain.handle('app:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  app.on('activate', () => {
    createWidgetWindow();
    showWidget({ reveal: false });
  });
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (balanceTimer) clearInterval(balanceTimer);
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  if (widgetUpdateTimer) clearTimeout(widgetUpdateTimer);
  if (topmostTimer) clearInterval(topmostTimer);
  if (proxy) await proxy.stop();
  if (codexWatcher) await codexWatcher.stop();
  if (store) await store.flush();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});












