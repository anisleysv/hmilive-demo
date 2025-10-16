/*****************************************************************************
 * Services: call local hmi-live (HS256, aud: hmilive:<serverId>)
 ****************************************************************************/
const fetch = require('node-fetch');
const AbortController = globalThis.AbortController || require('abort-controller');
const { signInternal } = require('../utils/jwtInternal'); // your updated signer

// Base URL for hmi-live (local-only)
const RAW_BASE = process.env.HMIDATA_URL || 'http://127.0.0.1:5000';
const BASE = RAW_BASE.replace(/\/+$/, ''); // strip trailing slashes

/** Small helper: parse JSON when possible, else text */
async function parseBody(res) {
  const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (ct.includes('application/json') && typeof res.json === 'function') {
    try { return await res.json(); } catch (_) { return null; }
  }
  if (typeof res.text === 'function') {
    try { return await res.text(); } catch (_) { return ''; }
  }
  return null;
}

/** Build Authorization header for hmi-live (audience: hmilive:<serverId>) */
function buildAuthHeaders(extra = {}) {
  const token = signInternal({}, { expiresIn: '30s', audPrefix: 'hmilive' });
  return { authorization: `Bearer ${token}`, ...extra };
}

/** Generic fetch to hmi-live (throws on hard errors) */
async function hmiFetch(path, { method = 'GET', body, headers = {}, softStatuses = [400, 404], noThrow = false, raw = false } = {}) {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const url = `${BASE}${suffix}`;

    const finalHeaders = buildAuthHeaders(headers);
    if (body != null && method !== 'GET' && method !== 'HEAD') {
        finalHeaders['content-type'] = finalHeaders['content-type'] || 'application/json';
    }
    
    const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body && method !== 'GET' && method !== 'HEAD' ? JSON.stringify(body) : undefined,
    });

    if (raw) {
      // In raw mode, return the Response directly (do not parse; do not throw)
      return { response: res };
    }

    const data = await parseBody(res);
    if (res.ok || noThrow || softStatuses.includes(res.status)) {
        return { ok: res.ok, status: res.status, data, headers: res.headers };
    }
    
    
    const err = new Error(`hmi-data-api ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
}

/** Read /status from hmi-live */
async function getHmiStatus() {
  return hmiFetch('/status', { method: 'GET' });
}

/** Read /hmi-structure from hmi-live */
async function getHmiStructure({lang = 'en'} = {}) {
  const qs = new URLSearchParams({lang}).toString();
  return hmiFetch(`/hmi-structure?${qs}`, { method: 'GET' });
}

async function getHmiLogo({ ifNoneMatch, ifModifiedSince } = {}) {
  // Build headers for cache revalidation
  const headers = {
    Accept: 'image/png',
  };
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch; 
  if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
 
  const { response } = await hmiFetch('/branding/logo',{
    method: 'GET',
    headers,
    raw: true
  });
  
  return response; // Node-Fetch Response (stream)
}

/**
 * Open upstream SSE (/hmi-data) and return its Response + AbortController.
 * The caller (handler) will set client SSE headers and pipe chunks.
 */
async function openHmiSse() {
  const url = `${BASE}/hmi-data`;
  const controller = new AbortController();
  const res = await fetch(url, {
    method: 'GET',
    headers: buildAuthHeaders(),
    signal: controller.signal,
  });
  return { response: res, controller };
}

module.exports = {
  getHmiStatus,
  getHmiStructure,
  openHmiSse,
  getHmiLogo
};
