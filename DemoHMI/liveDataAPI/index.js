/*****************************************************************************
 * @LastEditors           : Harold Garcia                                    *
 * @LastEditDate          : 2025-09-23 12:59:38                              *
 * @CopyRight             : DPPS                                             *
 ****************************************************************************/

const fs = require('fs');
const path = require('path');
const {verifyInternal} = require('./utils/jwt');
const { loadTranslations, translateLayout, translateMeta } = require('./languages/languageController');

// ---------- Config paths ----------
const ROOT_DIR = __dirname;
const META_FILE = path.join(ROOT_DIR, 'meta.ndjson');
const LAYOUT_FILE  = path.join(ROOT_DIR, 'layout.json');

// ---------- In-memory state for SSE ----------
const sseClients = new Set();
let lastSent = new Map();       // tagId -> { value, ts }
let pollTimer = null;
const POLL_MS = Number(process.env.SSE_POLL_MS || 250);

// --- PLC comms state (heartbeat/handshake) ---
let lastBeatTs = null;          // last time we detected a valid beat
let lastBeatVal = undefined;    // last raw value read from heartbeat/handshake tag
let lastCommsOk = null;         // last emitted comms state (null=unknown, true=ok, false=loss)

// Timeout to declare comm-loss if no change happens in time
// Defaults to ~6 polls; override with env HEARTBEAT_TIMEOUT_MS if you want a fixed value.
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || (POLL_MS * 6));


// ---------- Loaders ----------
function loadWidgetsNDJSON(file = META_FILE) {
  // Return Map<templateTagId, templateMeta>
  const map = new Map();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        const obj = JSON.parse(l);
        if (obj && obj.tagId) map.set(String(obj.tagId), obj);
      } catch { /* ignore malformed line */ }
    }
  } catch { /* file missing -> empty */ }
  return map;
}

function loadLayoutJSON(file = LAYOUT_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : { pages: [] };
  } catch {
    return { pages: [] };
  }
}

// ---------- Template resolver ----------
function escReg(s) { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }

/** Try to match a concrete tag against a single-# template. Return captured number or null. */
function captureNumbers(concrete, templateWithHashes) {
  // Escape regex metachars but keep '#' unescaped so we can transform them
  const pattern = '^' + escReg(templateWithHashes).replace(/#/g, '([0-9]+)') + '$';
  const rx = new RegExp(pattern);
  const m = concrete.match(rx);
  return m ? m.slice(1) : null; // all captured numbers as strings
}

/** Replace each '#' in a string with the next capture value. */
function applyCaptures(str, caps) {
  if (!str || !Array.isArray(caps) || caps.length === 0) return str;
  let i = 0;
  return String(str).replace(/#/g, () => (caps[i++] ?? ''));
}

/** Build meta for a concrete tag from a template (apply all '#' placeholders). */
function materializeTemplate(tpl, concreteTag) {
  const caps = captureNumbers(concreteTag, tpl.tagId); // array or null
  const meta = { ...tpl, tagId: concreteTag };

  if (typeof meta.label === 'string') {
    meta.label = applyCaptures(meta.label, caps || []);
  }
  if (typeof meta.description === 'string') {
    meta.description = applyCaptures(meta.description, caps || []);
  }
  
  return meta;
}

// ---------- Layout utilities ----------
/** Collect concrete tag references from layout; support items[] or widgets[]; string or {tagId} object. */
const TAG_REGEX = /^(TOHMI_|FRMHMI_|ALARM_|WARNING_|Feedpoint\d+_|Recipe_Feedpoint\d+_)/;

function collectConcreteTags(layout) {
  const found = [];
  const seen = new Set();

  const add = (tagId, override = null) => {
    if (!tagId || typeof tagId !== 'string') return;
    const id = tagId.trim();
    if (!id || !TAG_REGEX.test(id) || seen.has(id)) return;
    seen.add(id);
    found.push({ tagId: id, override });
  };

  const scan = (val) => {
    if (!val) return;

    // string
    if (typeof val === 'string') {
      if (!val.startsWith('key_')) add(val, null);
      return;
    }

    // array
    if (Array.isArray(val)) {
      for (const v of val) scan(v);
      return;
    }

    // object
    if (typeof val === 'object') {
      // Legacy { tagId, override }
      if (typeof val.tagId === 'string') {
        add(val.tagId, val.override || null);
      }
      for (const [k, v] of Object.entries(val)) {
        if (k === 'override' || k === 'component' || k === 'key' || k === 'title' || k === 'id') continue;
        scan(v);
      }
    }
  };

  const pages = Array.isArray(layout.pages) ? layout.pages : [];
  for (const p of pages) {
    const sections = Array.isArray(p.sections) ? p.sections : [];
    for (const s of sections) {
      const items = Array.isArray(s.items) ? s.items : (Array.isArray(s.widgets) ? s.widgets : []);
      for (const it of items) scan(it);
    }
  }
  return found;
}

/** Build registry: { tags: string[], metaByTag: Map, overrides applied } */
function buildRegistry(layout, widgetsMap) {
  const entries = collectConcreteTags(layout);
 
  const tags = [];
  const metaByTag = new Map();

  for (const { tagId, override } of entries) {
    // Find matching template: normalize by replacing first number block with '#'
    let chosen = null;
    for (const [tplId, tpl] of widgetsMap) {
      if (captureNumbers(tagId, tplId)) { chosen = tpl; break; }
    }
    const base = chosen || { tagId, label: tagId, widget: 'raw', valueType: 'string' };
    const concreteMeta = materializeTemplate(base, tagId);
    const merged = override ? ({ ...concreteMeta, ...override }) : concreteMeta;
    if (!metaByTag.has(tagId)) {
      metaByTag.set(tagId, merged);
      tags.push(tagId);
    }
  }
  return { tags, metaByTag };
}

// ---------- Data access (reads from your myDataAll) ----------
/**
 * Read a single tag value from myDataAll. Supports:
 *  - Array of { tagId|name|id|tag, value, ts? }
 *  - Object map { [tagId]: value } or { [tagId]: { value, ts } }
 */
function readOne(myDataAll, tagId) {
  if (!myDataAll) return { value: null, ts: null };

  if (Array.isArray(myDataAll)) {
    // Find first matching entry by common key names
    for (const row of myDataAll) {
      if (!row || typeof row !== 'object') continue;
      const key = row.tagId ?? row.name ?? row.tag ?? row.id;
      if (key === tagId) {
        const v = row.value ?? row.val ?? row.v ?? null;
        const ts = row.ts ?? row.timestamp ?? null;
        return { value: v, ts };
      }
    }
    return { value: null, ts: null };
  }

  // Object map cases
  if (Object.prototype.hasOwnProperty.call(myDataAll, tagId)) {
    const v = myDataAll[tagId];
    if (v && typeof v === 'object' && ('value' in v || 'ts' in v)) {
      return { value: v.value ?? null, ts: v.ts ?? null };
    }
    return { value: v, ts: null };
  }
  return { value: null, ts: null };
}

/** Build a snapshot for a list of tagIds from myDataAll */
function buildSnapshot(myDataAll, tagIds) {
  return tagIds.map(t => ({ tagId: t, ...readOne(myDataAll, t) }));
}

// ---------- SSE core ----------
function sseHeaders(res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
}

function sseWrite(res, type, data) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Compute current PLC comms state based on settings. Optionally advances global beat state.
 * - Uses settings.HEARTBEAT tag name: "TOHMI_CRC_Handshake" OR "Heartbeat" (or fallback "Heartbeat")
 * - Heartbeat: toggling value implies beat.
 * - Handshake/CRC: numeric >= 0 and changing over time implies beat.
 */
function computePlcCommsState(getAllData, getAllSettings, { advanceState = false } = {}) {
  const data = getAllData();
  const settings = (typeof getAllSettings === 'function' ? (getAllSettings() || {}) : {}) || {};
  const hbTag = settings.HEARTBEAT || 'TOHMI_CRC_Handshake';
   
  const { value: hbVal } = readOne(data, hbTag);
  const now = Date.now();
  const tagNameLc = String(hbTag).toLowerCase();
  const isHeartbeat = tagNameLc.includes('heartbeat');
  const isHandshakeLike = tagNameLc.includes('handshake');
  
  let beatDetected = false;

  if (isHeartbeat) {
    // Heartbeat toggles: change vs last value = beat
    if (lastBeatVal !== undefined && hbVal !== lastBeatVal) beatDetected = true;
  } else if (isHandshakeLike) {
    // Handshake/CRC increments 0..N; exists >=0 and changes = beat
    const num = Number(hbVal);
    if (Number.isFinite(num) && num >= 0) {
      if (lastBeatVal === undefined || num !== Number(lastBeatVal)) beatDetected = true;
    }
  } else {
    // Fallback: any change means beat
    if (lastBeatVal !== undefined && hbVal !== lastBeatVal) beatDetected = true;
  }

  if (advanceState && beatDetected) {
    lastBeatTs = now;
  }
  if (advanceState) {
    lastBeatVal = hbVal;
  }

  const commsOk = lastBeatTs != null && (now - lastBeatTs) <= HEARTBEAT_TIMEOUT_MS;

  return {
    ok: commsOk,
    ts: now,
    tag: hbTag,
    value: hbVal ?? null,
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
  };
}

function startPolling(getAllData, getAllSettings, tags) {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    try {
      const data = getAllData();

      // -------- Existing tags diff/patch --------
      const updates = [];
      for (const t of tags) {
        const cur = readOne(data, t);
        const prev = lastSent.get(t);

        const valueChanged = !prev || prev.value !== cur.value;

        if (valueChanged) {
          const ts = cur.ts ?? Date.now();
          lastSent.set(t, { value: cur.value, ts });
          updates.push({ tagId: t, value: cur.value, ts });
        } else if (prev && cur.ts != null && cur.ts > prev.ts) {
          lastSent.set(t, { value: prev.value, ts: cur.ts });
        }
      }
      if (updates.length && sseClients.size) {
        for (const c of sseClients) sseWrite(c, 'patch', { updates });
      }

      // -------- PLC comms detection & event --------
      const plc = computePlcCommsState(getAllData, getAllSettings, { advanceState: true });
      if (lastCommsOk === null || plc.ok !== lastCommsOk) {
        lastCommsOk = plc.ok;
        if (sseClients.size) {
          for (const c of sseClients) sseWrite(c, 'plc-comms', plc);
        }
      }
    } catch {
      // swallow polling errors; next tick will retry
    }
  }, POLL_MS);
}


// ---------- Main attach ----------
function attach(app, { getOpcuaState, getAllData, getAllSettings }) {
  // Protect EVERYTHING with JWT; no public endpoints to avoid external probing.
  app.use((req, res, next) => {
    try {
      // Expect "Authorization: Bearer <token>"
      const auth = req.headers['authorization'] || '';
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (!m) {
        return res.status(401).json({ error: 'missing bearer token' });
      }
      const token = m[1];
     
      // Verify with local derived HS256 key
      const claims = verifyInternal(token); // will throw if invalid
      req.jwt = claims;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid token', detail: err.message });
    }
  });
  // 1) Load config (once)
  const widgetsMap = loadWidgetsNDJSON();
  const layout = loadLayoutJSON();
 
  const registry = buildRegistry(layout, widgetsMap);

  // 2) Root (works even if OPC UA is down)
  app.get('/', (_req, res) => {
    res.status(200).send('hmi-live is running');
  });

  // 3) Status (works even if OPC UA is down)
  app.get('/status', (_req, res) => {
    const state = typeof getOpcuaState === 'function' ? (getOpcuaState() || 'unknown') : 'unknown';
    const settings = typeof getAllSettings === 'function' ? (getAllSettings() || 'unknown') : 'unknown';
    
    res.json({
      settingsRegistry: settings,
      opcuaState: state,
      tags: registry.tags.length,
      clients: sseClients.size,
      pollMs: POLL_MS
    });
  });

  // 4) HMI structure + initial values (filtered by layout)
  app.get('/hmi-structure', (_req, res) => {
   
    const lang = (_req.query.lang || 'en').toString().trim().toLowerCase();
    const myDataAll = typeof getAllData === 'function' ? (getAllData() || null) : null;
    const snapshot = buildSnapshot(myDataAll, registry.tags);
    // Build meta object { tagId: meta }
    const metaObj = {};
    for (const [k, v] of registry.metaByTag.entries()) metaObj[k] = v;

    const dict = loadTranslations(lang);
    
    const localizedLayout = translateLayout(layout, dict);
    const localizedMeta   = translateMeta(metaObj, dict);

    const brandingOut = { ...(layout.branding || {}) };
    const settings = typeof getAllSettings === 'function' ? (getAllSettings() || 'unknown') : 'unknown';
   
    if (brandingOut.hostname == null) {
      brandingOut.hostname = settings.SERVER_NAME || 'Unknown';
    }
    
    res.json({
      version: localizedLayout.version || null,
      branding: brandingOut,
      pages: localizedLayout.pages || [],
      tags: registry.tags,
      meta: localizedMeta,
      data: snapshot,
      status: {
        opcuaState: (typeof getOpcuaState === 'function' ? (getOpcuaState() || 'unknown') : 'unknown'),
        clients: sseClients.size
      },
      i18n: { lang }
    });
  });

  // 5) SSE for live data
  app.get('/hmi-data', (req, res) => {
    // Only GET allowed (common REST practice)
    if (req.method !== 'GET') {
      res.set('Allow', 'GET');
      return res.status(405).send('Method Not Allowed');
    }

    sseHeaders(res);

    // Send initial snapshot (clients may already have it from /hmi-structure)
    const state = typeof getOpcuaState === 'function' ? (getOpcuaState() || 'unknown') : 'unknown';
    sseWrite(res, 'hello', { ts: Date.now(), opcuaState: state, pollMs: POLL_MS });

    try {
      const myDataAll = typeof getAllData === 'function' ? (getAllData() || null) : null;
      const initial = buildSnapshot(myDataAll, registry.tags).map(row => ({
        tagId: row.tagId,
        value: row.value,
        ts: row.ts ?? Date.now()
      }));
      if (initial.length) {
        sseWrite(res, 'patch', { updates: initial });
      }
      try {
        const plc = computePlcCommsState(getAllData, getAllSettings, { advanceState: true });
        sseWrite(res, 'plc-comms', plc);
      } catch (_) {}
    } catch (_) {}

    // Track client
    sseClients.add(res);

    // Start polling loop if not already running
    startPolling(getAllData, getAllSettings, registry.tags);

    // Clean up on close
    req.on('close', () => {
      try { sseClients.delete(res); } catch {}
    });
  });

  // 6) Branding: stream logo image from disk
  app.get('/branding/logo', (req, res) => {
    try {
      // Resolve logo file path from layout.branding.logo.path, default if missing
      const rel = (layout?.branding?.logo?.path).replace(/^[/\\]+/, '');
      const p = path.resolve(ROOT_DIR, '..')
      const filePath = path.join(p, rel);
      
      fs.stat(filePath, (err, stat) => {
        if (err || !stat?.isFile()) {
          return res.status(404).json({ error: 'logo not found' });
        }

        // Set caching and content headers
        const etag = `"${stat.size}-${stat.mtimeMs}"`;
        res.setHeader('Content-Type', layout?.branding?.logo?.mime || 'image/png');
        res.setHeader('Cache-Control', 'public, no-cache');
        res.setHeader('Last-Modified', stat.mtime.toUTCString());
        res.setHeader('ETag', etag);

        // Handle conditional requests (revalidation)
        const inm = req.headers['if-none-match'];
        const ims = req.headers['if-modified-since'];
        if ((inm && inm === etag) || (ims && new Date(ims).getTime() >= stat.mtime.getTime())) {
          return res.status(304).end();
        }

        // For HEAD requests, send headers only
        if (req.method === 'HEAD') {
          return res.status(200).end();
        }

        // Stream the image bytes
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => { try { res.status(500).end(); } catch {} });
        stream.pipe(res);
      });
    } catch (e) {
      return res.status(500).json({ error: 'logo stream error', detail: e?.message || String(e) });
    }
  });


  // Optional: small keepalive to prevent idle timeouts (comment out if not needed)
  setInterval(() => {
    if (!sseClients.size) return;
    for (const c of sseClients) {
      try { sseWrite(c, 'heartbeat', { ts: Date.now() }); } catch {}
    }
  }, 3000);

  // Log basic info
  console.log(`[hmi-live] Loaded widgets: ${widgetsMap.size}, pages: ${Array.isArray(layout.pages) ? layout.pages.length : 0}, tags: ${registry.tags.length}`);
}

module.exports = { attach };
