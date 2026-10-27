const $ = (selector) => document.querySelector(selector);
const widget = $('#widget');
const USD_TO_CNY = 7.2;
let snapshot = null;
let lastLatestStamp = null;
let lastTodaySpend = null;
let bumpTimer = null;

const providerNames = {
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  custom: '自定义网关',
};

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return `${Math.round(number)}`;
}

function formatMoney(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (Math.abs(number) >= 1000) return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return number.toFixed(digits);
}

function setSyncState(label, state) {
  const element = $('#syncLabel');
  element.className = `sync-label ${state || ''}`.trim();
  element.innerHTML = `<i></i>${label}`;
}

function updateBalance(balance, settings = snapshot?.settings, latest = null) {
  const currency = balance?.currency || settings?.currency || 'CNY';
  $('#currency').textContent = currency === 'CNY' ? '¥' : '$';
  const hasBalance = balance?.value != null && Number.isFinite(Number(balance.value));
  $('#balance').textContent = hasBalance ? formatMoney(balance.value, 2) : '—';
  const todaySpend = Number(balance?.todaySpend);
  if (Number.isFinite(todaySpend)) {
    if (lastTodaySpend != null && todaySpend > lastTodaySpend + 0.0000001) {
      showBalanceChargeBubble(todaySpend - lastTodaySpend, currency);
    }
    lastTodaySpend = todaySpend;
  }
  $('#balance').title = balance?.projected ? '余额已按本次请求估算扣减，待服务商同步后校准' : '';
  const localCodex = latest?.provider === 'codex' || latest?.source === 'codex-local';
  $('#providerName').textContent = (localCodex && !hasBalance) ? 'Codex 本地' : (balance?.providerName || providerNames[settings?.provider] || 'WhaleMeter');
  $('#previewTag').hidden = !balance?.demo;
  if (balance?.demo) setSyncState('预览数据', '');
  else if (balance?.projected) setSyncState('实时扣费', '');
  else if (balance?.status === 'ok') setSyncState(localCodex ? '只读·已同步' : '余额已同步', '');
  else if (balance?.status === 'error') setSyncState('同步失败', '');
  else if (localCodex) setSyncState('只读监控', '');
  else if (balance?.status === 'unconfigured') setSyncState('待配置', '');
  else setSyncState('同步中', 'syncing');
}

function chargeLabel(costUsd, currency) {
  const amount = Math.max(0, Number(costUsd) || 0) * (currency === 'CNY' ? USD_TO_CNY : 1);
  const symbol = currency === 'CNY' ? '¥' : '$';
  const digits = amount >= 0.01 ? 4 : 6;
  return `-${symbol}${amount.toFixed(digits)}`;
}

function appendChargeBubble(labelText, valueText) {
  const layer = $('#bubbleLayer');
  while (layer.children.length >= 4) layer.firstElementChild?.remove();
  const bubble = document.createElement('div');
  const drift = `${(Math.random() * 30 - 15).toFixed(1)}px`;
  bubble.className = 'charge-bubble';
  bubble.style.setProperty('--drift', drift);
  const label = document.createElement('span');
  label.textContent = labelText;
  const value = document.createElement('strong');
  value.textContent = valueText;
  bubble.append(label, value);
  layer.append(bubble);
  bubble.addEventListener('animationend', () => bubble.remove(), { once: true });

  widget.classList.remove('bump');
  void widget.offsetWidth;
  widget.classList.add('bump');
  if (bumpTimer) clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => widget.classList.remove('bump'), 470);
}

function showBalanceChargeBubble(amount, currency) {
  const symbol = currency === 'CNY' ? '¥' : '$';
  const digits = amount >= 0.01 ? 4 : 6;
  appendChargeBubble('余额扣减', `-${symbol}${amount.toFixed(digits)}`);
}

function showChargeBubble(latest, currency) {
  appendChargeBubble(
    latest?.costKnown ? '估算扣费' : '本次用量',
    latest?.costKnown ? chargeLabel(latest.costUsd, currency) : `+${formatTokens(latest?.tokens || 0)} tok`,
  );
}

function render(next, { animate = false } = {}) {
  if (!next) return;
  const previous = snapshot;
  snapshot = next;
  const summary = next.summary || {};
  const latest = summary.latest;
  updateBalance(next.balance, next.settings, latest);
  const todaySymbol = (next.balance?.currency || next.settings?.currency) === 'CNY' ? '¥' : '$';
  if (next.balance?.todaySpend != null && Number.isFinite(Number(next.balance.todaySpend))) $('#todayCost').textContent = `${todaySymbol}${formatMoney(next.balance.todaySpend, 2)}`;
  else if (summary.unknownCostEvents && !summary.costUsd) $('#todayCost').textContent = '费用未知';
  else if (summary.unknownCostEvents) $('#todayCost').textContent = `$${formatMoney(summary.costUsd || 0)}+?`;
  else $('#todayCost').textContent = `$${formatMoney(summary.costUsd || 0)}`;
  $('#todayTokens').textContent = formatTokens(summary.tokens || 0);
  if (latest) {
    $('#latestModel').textContent = String(latest.model || 'unknown').split('/').pop();
    $('#latestCost').textContent = latest.costKnown ? `$${formatMoney(latest.costUsd || 0)}` : '—';
  } else {
    $('#latestModel').textContent = '等待第一笔请求';
    $('#latestCost').textContent = '—';
  }
  if (next.proxy) widget.classList.toggle('offline', !next.proxy.running);
  if (animate && latest?.timestamp && latest.timestamp !== lastLatestStamp) {
    showChargeBubble(latest, next.balance?.currency || next.settings?.currency || 'CNY');
  }
  lastLatestStamp = latest?.timestamp || lastLatestStamp;
  if (previous?.balance?.checkedAt !== next.balance?.checkedAt && previous) {
    widget.classList.remove('syncing');
    void widget.offsetWidth;
    widget.classList.add('syncing');
    setTimeout(() => widget.classList.remove('syncing'), 1150);
  }
}

function replayReveal() {
  widget.classList.remove('reveal');
  void widget.offsetWidth;
  widget.classList.add('reveal');
}

$('#closeWidgetBtn').addEventListener('click', () => window.whaleMeter.hideWidget());
$('#expandBtn').addEventListener('click', () => window.whaleMeter.widgetOpenDashboard());
$('#refreshBtn').addEventListener('click', async () => {
  const button = $('#refreshBtn');
  button.classList.add('spin');
  setSyncState('同步中', 'syncing');
  try {
    const balance = await window.whaleMeter.widgetRefreshBalance();
    updateBalance(balance, snapshot?.settings, snapshot?.summary?.latest);
    widget.classList.remove('syncing');
    void widget.offsetWidth;
    widget.classList.add('syncing');
    setTimeout(() => widget.classList.remove('syncing'), 1100);
  } catch {
    setSyncState('同步失败', '');
  } finally {
    button.classList.remove('spin');
  }
});

window.whaleMeter.onWidgetSnapshot((next) => render(next));
window.whaleMeter.onWidgetUpdate((next) => render(next, { animate: true }));
window.whaleMeter.onWidgetBalance((balance) => {
  if (!snapshot) return;
  snapshot.balance = balance;
  updateBalance(balance, snapshot.settings, snapshot.summary?.latest);
});
window.whaleMeter.onWidgetProxy((proxy) => {
  if (snapshot) snapshot.proxy = proxy;
  widget.classList.toggle('offline', !proxy.running);
});
window.whaleMeter.onWidgetSettings((settings) => {
  if (!snapshot) return;
  snapshot.settings = settings;
  updateBalance(snapshot.balance, settings, snapshot.summary?.latest);
});
window.whaleMeter.onWidgetReveal(() => {
  replayReveal();
  if (snapshot?.proxy?.running === false) setSyncState('代理离线', '');
});

window.whaleMeter.widgetBootstrap().then((next) => {
  render(next);
  replayReveal();
});






