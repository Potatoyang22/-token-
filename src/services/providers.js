const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    balanceKind: 'balance',
    upstreamBaseUrl: 'https://api.deepseek.com',
    currency: 'CNY',
    keyHint: '在 platform.deepseek.com 创建 API Key',
    balanceHint: '余额来自 /user/balance，按平台返回的币种显示。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    balanceKind: 'credits',
    upstreamBaseUrl: 'https://openrouter.ai/api',
    currency: 'USD',
    keyHint: '在 openrouter.ai/keys 创建 API Key',
    balanceHint: '余额 = total_credits - total_usage。',
  },
  {
    id: 'custom',
    name: '自定义网关',
    balanceKind: 'custom',
    upstreamBaseUrl: 'https://your-gateway.example.com',
    currency: 'USD',
    keyHint: '填写网关 API Key',
    balanceHint: '配置一个返回 JSON 的 GET 余额地址，并填写数值字段路径。',
  },
];

function presetFor(provider) {
  return PROVIDER_PRESETS.find((entry) => entry.id === provider) || PROVIDER_PRESETS[0];
}

function jsonValueAtPath(value, dottedPath) {
  if (!dottedPath) return value;
  return dottedPath.split('.').filter(Boolean).reduce((current, part) => {
    if (current == null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
    return current[part];
  }, value);
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`接口返回了非 JSON 内容 (${response.status})`);
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || payload?.error || text.slice(0, 160);
      throw new Error(`${response.status} ${detail || response.statusText}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBalance({ settings, apiKey }) {
  const preset = presetFor(settings.provider);
  if (!apiKey) {
    return {
      provider: preset.id,
      providerName: preset.name,
      status: 'unconfigured',
      currency: settings.currency || preset.currency,
      value: null,
      checkedAt: new Date().toISOString(),
      message: '还没有填写 API Key',
    };
  }

  try {
    if (preset.id === 'deepseek') {
      const payload = await fetchJson('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
      const info = infos[0] || {};
      return {
        provider: preset.id,
        providerName: preset.name,
        status: payload.is_available === false ? 'unavailable' : 'ok',
        currency: info.currency || 'CNY',
        value: toNumber(info.total_balance),
        granted: toNumber(info.granted_balance),
        toppedUp: toNumber(info.topped_up_balance),
        checkedAt: new Date().toISOString(),
        message: payload.is_available === false ? '账户当前不可用' : '余额已同步',
      };
    }

    if (preset.id === 'openrouter') {
      const payload = await fetchJson('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      const data = payload.data || {};
      const total = toNumber(data.total_credits);
      const used = toNumber(data.total_usage);
      return {
        provider: preset.id,
        providerName: preset.name,
        status: 'ok',
        currency: 'USD',
        value: total == null || used == null ? null : total - used,
        total,
        used,
        checkedAt: new Date().toISOString(),
        message: 'Credits 已同步',
      };
    }

    if (!settings.balanceUrl) {
      return {
        provider: preset.id,
        providerName: preset.name,
        status: 'unconfigured',
        currency: settings.currency || 'USD',
        value: null,
        checkedAt: new Date().toISOString(),
        message: '请先填写自定义余额接口',
      };
    }

    const payload = await fetchJson(settings.balanceUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const value = toNumber(jsonValueAtPath(payload, settings.customBalancePath));
    if (value == null) throw new Error(`字段 ${settings.customBalancePath || '(root)'} 不是数值`);
    return {
      provider: preset.id,
      providerName: preset.name,
      status: 'ok',
      currency: settings.currency || 'USD',
      value,
      checkedAt: new Date().toISOString(),
      message: '自定义余额已同步',
    };
  } catch (error) {
    return {
      provider: preset.id,
      providerName: preset.name,
      status: 'error',
      currency: settings.currency || preset.currency,
      value: null,
      checkedAt: new Date().toISOString(),
      message: error.name === 'AbortError' ? '余额接口请求超时' : error.message,
    };
  }
}

module.exports = { PROVIDER_PRESETS, presetFor, fetchBalance, jsonValueAtPath };
