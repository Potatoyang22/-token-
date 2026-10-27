const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  settings: {},
  events: [],
  balance: null,
  providers: [],
  proxy: null,
  version: '0.1.0',
};

const refs = {
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  providerSelect: $('#providerSelect'),
  providerHint: $('#providerHint'),
  currencySelect: $('#currencySelect'),
  apiKeyInput: $('#apiKeyInput'),
  apiKeyHint: $('#apiKeyHint'),
  baseUrlInput: $('#baseUrlInput'),
  balanceUrlInput: $('#balanceUrlInput'),
  balancePathInput: $('#balancePathInput'),
  pollInput: $('#pollInput'),
  portInput: $('#portInput'),
  demoToggle: $('#demoToggle'),
  autoShowToggle: $('#autoShowToggle'),
  dialogError: $('#dialogError'),
  saveSettingsBtn: $('#saveSettingsBtn'),
  proxyUrl: $('#proxyUrl'),
  toast: $('#toast'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return Math.round(number).toLocaleString('zh-CN');
}

function formatMoney(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) >= 1000) return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return number.toFixed(digits);
}

function currencySymbol(currency) {
  return currency === 'CNY' ? '¥' : '$';
}

function relativeTime(iso) {
  if (!iso) return '尚未同步';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 8) return '刚刚同步';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function shortModel(model) {
  return String(model || 'unknown').split('/').pop();
}

function todayEvents() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return state.events.filter((event) => new Date(event.timestamp) >= start);
}

function computeSummary(events) {
  const tokens = events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0);
  const input = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const output = events.reduce((sum, event) => sum + event.outputTokens, 0);
  const cached = events.reduce((sum, event) => sum + event.cachedTokens, 0);
  const cost = events.reduce((sum, event) => sum + event.costUsd, 0);
  const unknownCostEvents = events.filter((event) => event.costKnown === false || (!event.costKnown && event.costUsd === 0 && event.source === 'codex-local')).length;
  const latency = events.length ? events.reduce((sum, event) => sum + event.latencyMs, 0) / events.length : 0;
  return { tokens, input, output, cached, cost, unknownCostEvents, latency, requests: events.length };
}

function renderBalance() {
  const balance = state.balance;
  const symbol = currencySymbol(balance?.currency || state.settings.currency);
  $('#providerChip').textContent = balance?.providerName || state.settings.provider || '未配置';
  $('#balanceCurrency').textContent = symbol;
  $('#balanceValue').textContent = balance?.value != null && Number.isFinite(Number(balance.value)) ? formatMoney(balance.value, 2) : '—';
  $('#balanceMessage').textContent = balance?.message || '填写 API Key 后同步真实余额';
  $('#balanceUpdated').textContent = balance ? relativeTime(balance.checkedAt) : '尚未同步';
  $('#demoChip').hidden = !(balance?.demo || state.events.some((event) => event.source === 'demo'));
  $('#accountProvider').textContent = state.providers.find((item) => item.id === state.settings.provider)?.name || state.settings.provider || '未配置';
  $('#accountBase').textContent = state.settings.upstreamBaseUrl || '未设置上游地址';
}

function renderMetrics(events) {
  const summary = computeSummary(events);
  $('#todayCost').textContent = summary.unknownCostEvents && !summary.cost ? '费用未知' : `$${formatMoney(summary.cost)}${summary.unknownCostEvents ? '+?' : ''}`;
  $('#todayTokens').textContent = formatTokens(summary.tokens);
  $('#todayRequests').textContent = String(summary.requests);
  $('#inputTokens').textContent = formatTokens(summary.input);
  $('#outputTokens').textContent = formatTokens(summary.output);
  $('#avgLatency').textContent = `${Math.round(summary.latency).toLocaleString('zh-CN')} ms`;
  const total = summary.input + summary.output;
  $('#inputShare').textContent = `${total ? Math.round(summary.input / total * 100) : 0}% 占比`;
  $('#outputShare').textContent = `${total ? Math.round(summary.output / total * 100) : 0}% 占比`;
  const cacheRate = summary.input ? Math.round(summary.cached / summary.input * 100) : 0;
  $('#cacheRate').textContent = `${cacheRate}%`;
  $('#cacheHint').textContent = summary.cached ? `${formatTokens(summary.cached)} tokens 命中缓存` : '等待缓存数据';
  $('#chartTotal').textContent = `$${formatMoney(summary.cost)}`;
  if (summary.requests) {
    const latest = events[events.length - 1];
    $('#whaleCaption').textContent = `鲸鱼刚刚吞下 ${formatTokens(latest.inputTokens + latest.outputTokens)} tokens`;
  } else {
    $('#whaleCaption').textContent = '正在巡游，等待第一笔请求';
  }
}

function buildChart(events) {
  const buckets = Array.from({ length: 8 }, (_, index) => ({ label: `${String(index * 3).padStart(2, '0')}:00`, cost: 0 }));
  for (const event of events) {
    const hour = new Date(event.timestamp).getHours();
    buckets[Math.min(7, Math.floor(hour / 3))].cost += event.costUsd;
  }
  const max = Math.max(...buckets.map((bucket) => bucket.cost), 0.000001);
  const width = 720;
  const height = 220;
  const pad = 8;
  const points = buckets.map((bucket, index) => ({
    x: pad + (index / (buckets.length - 1)) * (width - pad * 2),
    y: height - pad - (bucket.cost / max) * (height - pad * 2),
  }));
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L ${points.at(-1).x.toFixed(1)} ${height} L ${points[0].x.toFixed(1)} ${height} Z`;
  $('#linePath').setAttribute('d', line);
  $('#areaPath').setAttribute('d', area);
  $('#chartAxis').innerHTML = buckets.map((bucket) => `<span>${bucket.label}</span>`).join('');
}

function renderRequests(events) {
  const list = $('#requestList');
  const latest = events.slice(-9).reverse();
  if (!latest.length) {
    list.innerHTML = '<div class="empty-state">还没有请求<br />把 Base URL 指向本地代理后，鲸鱼就会开始记录。</div>';
    return;
  }
  list.innerHTML = latest.map((event) => {
    const time = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="request-row">
        <span class="request-indicator" style="background:${event.status >= 400 ? '#ff8398' : '#78e0c1'}"></span>
        <div class="request-main">
          <strong title="${escapeHtml(event.model)}">${escapeHtml(shortModel(event.model))}</strong>
          <span>${time} · ${formatTokens(event.inputTokens)} in / ${formatTokens(event.outputTokens)} out${event.estimated ? ' · est.' : ''}</span>
        </div>
        <div class="request-value">
          <strong>$${formatMoney(event.costUsd)}</strong>
          <span>${Math.round(event.latencyMs)} ms</span>
        </div>
      </div>`;
  }).join('');
}

function renderModelMix(events) {
  const grouped = new Map();
  for (const event of events) {
    const model = shortModel(event.model);
    grouped.set(model, (grouped.get(model) || 0) + event.inputTokens + event.outputTokens);
  }
  const rows = [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const total = rows.reduce((sum, row) => sum + row[1], 0);
  $('#modelCount').textContent = `${grouped.size} model${grouped.size === 1 ? '' : 's'}`;
  const container = $('#modelBreakdown');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state" style="height:160px">暂无模型数据</div>';
    return;
  }
  const max = rows[0][1] || 1;
  container.innerHTML = rows.map(([model, value]) => {
    const share = total ? Math.round(value / total * 100) : 0;
    const width = Math.max(4, Math.round(value / max * 100));
    return `<div class="model-line"><span class="model-name" title="${escapeHtml(model)}">${escapeHtml(model)}</span><span class="model-track"><i class="model-fill" style="width:${width}%"></i></span><span class="model-percent">${share}%</span></div>`;
  }).join('');
}

function renderProxy() {
  const proxy = state.proxy || {};
  const pill = $('#proxyStatusPill');
  if (proxy.running) {
    pill.textContent = `本地代理在线 · :${proxy.port}`;
    pill.classList.remove('down');
    $('#proxyUrl').textContent = proxy.baseUrl || `http://127.0.0.1:${proxy.port}/v1`;
    $('#liveStatus').textContent = `本地采集器在线 · 端口 ${proxy.port}`;
  } else {
    pill.textContent = proxy.error ? '本地代理启动失败' : '本地代理未启动';
    pill.classList.add('down');
    $('#liveStatus').textContent = proxy.error || '本地采集器离线';
  }
}

function render() {
  const events = todayEvents();
  renderBalance();
  renderMetrics(events);
  buildChart(events);
  renderRequests(events);
  renderModelMix(events);
  renderProxy();
  $('#versionLabel').textContent = `v${state.version}`;
}

function showToast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => refs.toast.classList.remove('show'), 2400);
}

function populateProviderOptions(selected) {
  refs.providerSelect.innerHTML = state.providers.map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`).join('');
  refs.providerSelect.value = selected || state.providers[0]?.id || 'deepseek';
  syncProviderFields(false);
}

function syncProviderFields(updateDefaults = true) {
  const provider = state.providers.find((item) => item.id === refs.providerSelect.value);
  if (!provider) return;
  refs.providerHint.textContent = provider.balanceHint;
  refs.apiKeyHint.textContent = state.settings.hasApiKey ? '已保存 API Key；留空会保留现有密钥。' : provider.keyHint;
  $('#customHint').textContent = '余额接口需返回 JSON，字段路径支持 data.balance 或 data.0.amount。';
  const custom = provider.id === 'custom';
  $$('.custom-only').forEach((element) => { element.hidden = !custom; });
  if (updateDefaults) {
    refs.baseUrlInput.value = provider.upstreamBaseUrl;
    refs.currencySelect.value = provider.currency;
  }
}

function openSettings() {
  const settings = state.settings;
  populateProviderOptions(settings.provider);
  refs.currencySelect.value = settings.currency || 'CNY';
  refs.apiKeyInput.value = '';
  refs.baseUrlInput.value = settings.upstreamBaseUrl || '';
  refs.balanceUrlInput.value = settings.balanceUrl || '';
  refs.balancePathInput.value = settings.customBalancePath || 'data.balance';
  refs.pollInput.value = settings.pollIntervalSeconds || 60;
  refs.portInput.value = settings.proxyPort || 8787;
  refs.demoToggle.checked = Boolean(settings.demoMode);
  refs.autoShowToggle.checked = settings.autoShowWidget !== false;
  refs.dialogError.hidden = true;
  refs.dialogError.textContent = '';
  syncProviderFields(false);
  refs.settingsDialog.showModal();
}

async function saveSettings() {
  refs.saveSettingsBtn.disabled = true;
  refs.saveSettingsBtn.textContent = '正在同步…';
  refs.dialogError.hidden = true;
  try {
    const patch = {
      provider: refs.providerSelect.value,
      currency: refs.currencySelect.value,
      upstreamBaseUrl: refs.baseUrlInput.value.trim(),
      balanceUrl: refs.balanceUrlInput.value.trim(),
      customBalancePath: refs.balancePathInput.value.trim() || 'data.balance',
      pollIntervalSeconds: Number(refs.pollInput.value),
      proxyPort: Number(refs.portInput.value),
      demoMode: refs.demoToggle.checked,
      autoShowWidget: refs.autoShowToggle.checked,
    };
    const apiKey = refs.apiKeyInput.value.trim();
    await window.whaleMeter.saveSettings({ patch, apiKey });
    refs.settingsDialog.close();
    await boot(false);
    showToast('账户配置已保存，余额已同步');
  } catch (error) {
    refs.dialogError.textContent = error.message || String(error);
    refs.dialogError.hidden = false;
  } finally {
    refs.saveSettingsBtn.disabled = false;
    refs.saveSettingsBtn.textContent = '保存并同步';
  }
}

async function clearApiKey() {
  if (!window.confirm('清除已保存的 API Key？')) return;
  await window.whaleMeter.saveSettings({ patch: { demoMode: true }, apiKey: '', clearApiKey: true });
  refs.settingsDialog.close();
  await boot(false);
  showToast('已清除 API Key，切回演示数据');
}

async function refreshBalance() {
  const button = $('#refreshBtn');
  button.disabled = true;
  try {
    state.balance = await window.whaleMeter.refreshBalance();
    render();
    showToast(state.balance?.status === 'ok' ? '余额已刷新' : state.balance?.message || '余额刷新完成');
  } catch (error) {
    showToast(error.message || '余额刷新失败');
  } finally {
    button.disabled = false;
  }
}

async function copyProxyUrl() {
  const text = $('#proxyUrl').textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  showToast('本地代理地址已复制');
}

function bindNavigation() {
  $$('.rail-btn[data-target]').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.rail-btn').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function bindWindowControls() {
  $('#minimizeBtn').addEventListener('click', () => window.whaleMeter.minimize());
  $('#maximizeBtn').addEventListener('click', () => window.whaleMeter.maximize());
  $('#closeBtn').addEventListener('click', () => window.whaleMeter.close());
}

async function boot(showErrors = true) {
  try {
    const snapshot = await window.whaleMeter.bootstrap();
    state.settings = snapshot.settings;
    state.events = snapshot.events || [];
    state.balance = snapshot.balance;
    state.providers = snapshot.providers || [];
    state.proxy = snapshot.proxy;
    state.version = snapshot.version || '0.1.0';
    render();
  } catch (error) {
    if (showErrors) showToast(`启动失败：${error.message}`);
    console.error(error);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  bindNavigation();
  bindWindowControls();
  $('#settingsNav').addEventListener('click', openSettings);
  $('#openSettingsBtn').addEventListener('click', openSettings);
  $('#editAccountBtn').addEventListener('click', openSettings);
  $('#refreshBtn').addEventListener('click', refreshBalance);
  $('#copyProxyBtn').addEventListener('click', copyProxyUrl);
  refs.providerSelect.addEventListener('change', () => syncProviderFields(true));
  refs.settingsForm.addEventListener('submit', (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    saveSettings();
  });
  refs.saveSettingsBtn.addEventListener('click', saveSettings);
  $('#clearKeyBtn').addEventListener('click', clearApiKey);

  window.whaleMeter.onUsage((event) => {
    state.events.push(event);
    state.events = state.events.slice(-1000);
    state.settings.demoMode = false;
    render();
  });
  window.whaleMeter.onBalance((balance) => { state.balance = balance; render(); });
  window.whaleMeter.onProxyStatus((proxy) => { state.proxy = proxy; renderProxy(); });
  window.whaleMeter.onSettings((settings) => { state.settings = settings; render(); });
  window.whaleMeter.onNavigate((section) => { if (section === 'settings') openSettings(); });

  await boot();
  setInterval(() => { renderBalance(); }, 30_000);
});



