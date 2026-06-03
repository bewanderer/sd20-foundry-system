import { CONFIG } from './config.js';
import { log, warn, debug } from './utils.js';

const SETTING_TOKEN = 'appAuthToken';
const SETTING_USER_UUID = 'appAuthUserUuid';
const SETTING_USERNAME = 'appAuthUsername';

export function registerAppAuthSettings() {
  game.settings.register(CONFIG.MODULE_ID, SETTING_TOKEN, {
    scope: 'client',
    config: false,
    type: String,
    default: ''
  });
  game.settings.register(CONFIG.MODULE_ID, SETTING_USER_UUID, {
    scope: 'client',
    config: false,
    type: String,
    default: ''
  });
  game.settings.register(CONFIG.MODULE_ID, SETTING_USERNAME, {
    scope: 'client',
    config: false,
    type: String,
    default: ''
  });
}

export function isSignedIn() {
  return !!(getToken() && getBoundUserUuid());
}

export function getToken() {
  try {
    return game.settings.get(CONFIG.MODULE_ID, SETTING_TOKEN) || '';
  } catch {
    return '';
  }
}

export function getBoundUserUuid() {
  try {
    return game.settings.get(CONFIG.MODULE_ID, SETTING_USER_UUID) || '';
  } catch {
    return '';
  }
}

export function getBoundUsername() {
  try {
    return game.settings.get(CONFIG.MODULE_ID, SETTING_USERNAME) || '';
  } catch {
    return '';
  }
}

async function clearBinding() {
  await game.settings.set(CONFIG.MODULE_ID, SETTING_TOKEN, '');
  await game.settings.set(CONFIG.MODULE_ID, SETTING_USER_UUID, '');
  await game.settings.set(CONFIG.MODULE_ID, SETTING_USERNAME, '');
  Hooks.callAll('sd20.appAuth.changed', { signedIn: false });
}

function normalizePairingCode(raw) {
  if (!raw) return '';
  return String(raw).replace(/[\s-]/g, '').toUpperCase();
}

export async function redeemPairingCode(rawCode) {
  const code = normalizePairingCode(rawCode);
  if (!code) {
    return { ok: false, error: 'Pairing code is required.' };
  }

  try {
    const response = await fetch(`${CONFIG.API_BASE_URL}/api/auth/foundry-pair-redeem/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    let body = null;
    try { body = await response.json(); } catch {}

    if (!response.ok) {
      const message = body?.error || body?.detail || `Pairing failed (${response.status}).`;
      return { ok: false, error: message };
    }

    const token = body?.token;
    const userUuid = body?.user?.uuid;
    const displayName = body?.user?.username || '';
    if (!token || !userUuid) {
      return { ok: false, error: 'Pairing returned an unexpected response shape.' };
    }

    await game.settings.set(CONFIG.MODULE_ID, SETTING_TOKEN, token);
    await game.settings.set(CONFIG.MODULE_ID, SETTING_USER_UUID, userUuid);
    await game.settings.set(CONFIG.MODULE_ID, SETTING_USERNAME, displayName);
    log(`Paired with SD20 App account "${displayName}" (${userUuid.slice(0, 8)}...)`);
    Hooks.callAll('sd20.appAuth.changed', { signedIn: true, userUuid, username: displayName });
    return { ok: true, userUuid, username: displayName };
  } catch (err) {
    warn('appAuth.redeemPairingCode failed', err);
    return { ok: false, error: err?.message || 'Network error during pairing.' };
  }
}

export async function logout() {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${CONFIG.API_BASE_URL}/api/auth/logout/`, {
        method: 'POST',
        headers: { 'Authorization': `Token ${token}` }
      });
    } catch (err) {
      debug('appAuth.logout: server call failed, clearing client state anyway', err);
    }
  }
  await clearBinding();
  log('Signed out of SD20 App.');
}

export async function apiGet(path) {
  const token = getToken();
  if (!token) {
    return { ok: false, status: 0, error: 'Not signed in.' };
  }
  const url = path.startsWith('http') ? path : `${CONFIG.API_BASE_URL}${path}`;
  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Token ${token}` }
    });
    if (response.status === 401) {
      warn('appAuth: API returned 401, clearing binding.');
      await clearBinding();
      return { ok: false, status: 401, error: 'Session expired.' };
    }
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      return { ok: false, status: response.status, error: data?.error || data?.detail || `Request failed (${response.status}).` };
    }
    return { ok: true, status: response.status, data };
  } catch (err) {
    warn(`appAuth.apiGet ${path} failed`, err);
    return { ok: false, status: 0, error: err?.message || 'Network error.' };
  }
}

export async function fetchOwnedCharacters() {
  const result = await apiGet('/api/characters/?own_only=true');
  if (!result.ok) return result;
  const data = result.data || [];
  const characters = Array.isArray(data) ? data : (data?.results || []);
  return { ok: true, characters };
}

export async function fetchCharacter(uuid) {
  if (!uuid) return { ok: false, error: 'Missing character UUID.' };
  return apiGet(`/api/characters/${encodeURIComponent(uuid)}/`);
}
