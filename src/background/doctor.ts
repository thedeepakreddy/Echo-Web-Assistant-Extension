import { getAuthConfig } from './auth';

export interface DoctorReport {
  provider: string;
  model: string;
  key: 'missing' | 'configured' | 'rejected' | 'valid' | 'unknown';
  modelStatus: 'available' | 'unavailable' | 'unverified';
  tab: 'ready' | 'restricted' | 'unavailable';
  permissions: 'ready' | 'missing';
  note: string;
}

function modelFor(config: Awaited<ReturnType<typeof getAuthConfig>>): string {
  switch (config.provider) {
    case 'claude': return config.anthropicModel || '';
    case 'gemini': return config.geminiModel || '';
    case 'groq': return config.groqModel || '';
    case 'togetherai': return config.togetherModel || '';
    case 'openrouter': return config.openrouterModel || '';
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const report: DoctorReport = {
    provider: 'not configured', model: 'none', key: 'unknown', modelStatus: 'unverified',
    tab: 'unavailable', permissions: 'missing', note: '',
  };

  try {
    report.permissions = await chrome.permissions.contains({ permissions: ['tabs', 'sidePanel', 'storage'] }) ? 'ready' : 'missing';
  } catch { /* show missing */ }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /^https?:/i.test(tab.url || '')) {
      const pong: any = await chrome.tabs.sendMessage(tab.id, { type: 'ECHO_PING' });
      report.tab = pong?.success ? 'ready' : 'unavailable';
    } else report.tab = 'restricted';
  } catch { report.tab = 'unavailable'; }

  let config: Awaited<ReturnType<typeof getAuthConfig>>;
  try {
    config = await getAuthConfig();
  } catch (error: any) {
    const { provider } = await chrome.storage.local.get(['provider']);
    report.provider = String(provider || 'claude');
    report.key = 'missing';
    report.note = String(error?.message || 'Configure an API key and model in Settings.');
    return report;
  }

  report.provider = config.provider;
  report.model = modelFor(config);
  report.key = 'configured';
  if (!report.model) {
    report.note = 'Choose a model ID in Settings.';
    return report;
  }

  let url = '';
  const headers: Record<string, string> = {};
  if (config.provider === 'claude') {
    url = `https://api.anthropic.com/v1/models/${encodeURIComponent(report.model)}`;
    headers['x-api-key'] = config.anthropicApiKey || '';
    headers['anthropic-version'] = '2023-06-01';
  } else if (config.provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(report.model)}`;
    headers['x-goog-api-key'] = config.geminiApiKey || '';
  } else if (config.provider === 'groq') {
    url = `https://api.groq.com/openai/v1/models/${encodeURIComponent(report.model)}`;
    headers.Authorization = `Bearer ${config.groqApiKey}`;
  } else if (config.provider === 'togetherai') {
    url = 'https://api.together.xyz/v1/models';
    headers.Authorization = `Bearer ${config.togetherApiKey}`;
  } else {
    url = 'https://openrouter.ai/api/v1/models';
    headers.Authorization = `Bearer ${config.openrouterApiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    if (config.provider === 'openrouter') {
      const keyCheck = await fetch('https://openrouter.ai/api/v1/key', { headers, signal: controller.signal });
      if (keyCheck.status === 401 || keyCheck.status === 403) {
        report.key = 'rejected';
        report.note = 'OpenRouter rejected this API key.';
        return report;
      }
      if (!keyCheck.ok) {
        report.note = `OpenRouter key check returned HTTP ${keyCheck.status}.`;
        return report;
      }
      report.key = 'valid';
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      report.key = 'rejected';
      report.note = 'The provider rejected this API key or its permissions.';
    } else if (response.status === 404) {
      report.modelStatus = 'unavailable';
      report.note = 'The selected model was not found. Choose a current model ID.';
    } else if (!response.ok) {
      report.note = `Provider returned HTTP ${response.status}; model availability could not be checked.`;
    } else {
      if (config.provider !== 'togetherai') report.key = 'valid';
      const body: any = await response.json();
      if (config.provider === 'claude' || config.provider === 'gemini' || config.provider === 'groq') {
        report.modelStatus = 'available';
      } else {
        const models: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
        report.modelStatus = models.some(m => m.id === report.model)
          || (config.provider === 'openrouter' && ['openrouter/free', 'openrouter/auto'].includes(report.model))
          ? 'available' : 'unverified';
        if (report.modelStatus === 'unverified') report.note = 'Key works, but this model was not in the provider list. Try a direct task or select another model.';
        if (config.provider === 'togetherai') report.note = 'Model list loaded; this endpoint may not verify the key. Try a task to verify access.';
      }
    }
  } catch {
    report.note = 'Could not reach the provider within 10 seconds. Check connection or try again.';
  } finally { clearTimeout(timer); }
  return report;
}
