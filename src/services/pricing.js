const PRICING_PER_MILLION = [
  { match: /^gpt-5/i, input: 1.25, output: 10, label: 'GPT-5' },
  { match: /^gpt-4\.1-mini/i, input: 0.4, output: 1.6, label: 'GPT-4.1 mini' },
  { match: /^gpt-4\.1-nano/i, input: 0.1, output: 0.4, label: 'GPT-4.1 nano' },
  { match: /^gpt-4\.1/i, input: 2, output: 8, label: 'GPT-4.1' },
  { match: /^gpt-4o-mini/i, input: 0.15, output: 0.6, label: 'GPT-4o mini' },
  { match: /^gpt-4o/i, input: 2.5, output: 10, label: 'GPT-4o' },
  { match: /^o4-mini/i, input: 1.1, output: 4.4, label: 'o4-mini' },
  { match: /^o3-mini/i, input: 1.1, output: 4.4, label: 'o3-mini' },
  { match: /^o3/i, input: 2, output: 8, label: 'o3' },
  { match: /^deepseek-reasoner/i, input: 0.55, output: 2.19, label: 'DeepSeek Reasoner' },
  { match: /^deepseek-chat/i, input: 0.27, output: 1.1, label: 'DeepSeek Chat' },
  { match: /^claude-.*opus/i, input: 15, output: 75, label: 'Claude Opus' },
  { match: /^claude-.*sonnet/i, input: 3, output: 15, label: 'Claude Sonnet' },
  { match: /^claude-.*haiku/i, input: 0.8, output: 4, label: 'Claude Haiku' },
  { match: /^gemini-2\.5-pro/i, input: 1.25, output: 10, label: 'Gemini 2.5 Pro' },
  { match: /^gemini-2\.5-flash/i, input: 0.3, output: 2.5, label: 'Gemini 2.5 Flash' },
  { match: /^qwen/i, input: 0.4, output: 1.2, label: 'Qwen' },
  { match: /^glm/i, input: 0.6, output: 2.2, label: 'GLM' },
];

const FALLBACK = { input: 1, output: 3, label: 'Unknown model' };

function getPricing(model = '') {
  const normalized = String(model).toLowerCase().replace(/^.*\//, '');
  return PRICING_PER_MILLION.find((entry) => entry.match.test(normalized)) || FALLBACK;
}

function calculateCostUsd(model, usage = {}) {
  const pricing = getPricing(model);
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  const cachedTokens = Number(usage.cachedTokens) || 0;
  const billableInput = Math.max(0, inputTokens - cachedTokens);
  if (pricing === FALLBACK) {
    return {
      costUsd: 0,
      estimatedPricing: true,
      pricingKnown: false,
      pricing,
    };
  }
  const costUsd = (
    billableInput * pricing.input
    + cachedTokens * pricing.input * 0.25
    + outputTokens * pricing.output
  ) / 1_000_000;
  return {
    costUsd,
    estimatedPricing: false,
    pricingKnown: true,
    pricing,
  };
}

module.exports = { calculateCostUsd, getPricing, PRICING_PER_MILLION };

