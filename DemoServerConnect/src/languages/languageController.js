const fs = require('fs');
const path = require('path');

const JSON_DIR = path.join(__dirname, 'json');
const cache = new Map();

function loadTranslations(lang = 'en') {
  const code = String(lang || 'en').toLowerCase();
  if (cache.has(code)) return cache.get(code);

  const tryRead = (f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch { return null; }
  };

  const primary = tryRead(path.join(JSON_DIR, `${code}.json`));
  if (primary) { cache.set(code, primary); return primary; }

  const fallback = tryRead(path.join(JSON_DIR, 'en.json')) || {};
  cache.set(code, fallback);
  return fallback;
}

function translateKey(rawKey, dict) {
  if (typeof rawKey !== 'string') return rawKey;

  // Expect keys like "key-sc_project_saved_ok"; strip "key-sc_"
  const key = rawKey.slice(7).toLowerCase();
  const numbers = key.match(/\d+/g) || [];
  const generic = key.replace(/\d+/g, '#');

  let str = dict[key] ?? dict[generic];
  if (typeof str !== 'string') return rawKey;

  // Replace #1, #2... with captured numbers
  let out = str;
  numbers.forEach((n, i) => { out = out.replace(new RegExp(`#${i + 1}`, 'g'), n); });
  return out;
}

/** Detect best language code from query/header */
function detectLang(req) {
  const q = (req.query?.lang || '').trim();
  if (q) return q;

  const hdr = (req.headers['x-lang'] || '').trim();
  if (hdr) return hdr;

  const al = (req.headers['accept-language'] || '').trim();
  if (al) {
    // e.g. "es-ES,es;q=0.9" -> "es"
    const primary = al.split(',')[0]?.split(';')[0]?.split('-')[0];
    if (primary) return primary;
  }
  return 'en';
}

/** Translate any string that looks like a translation key ("key-sc_*") */
function translateIfKey(str, dict) {
  // Keep non-strings unchanged
  if (typeof str !== 'string') return str;
  return /^key-sc_/i.test(str) ? translateKey(str, dict) : str;
}

/** Deep translation walk for objects/arrays/strings */
function translatePayload(value, dict) {
  if (value == null) return value;

  // Strings: translate if they look like a key "key-sc_*"
  if (typeof value === 'string') return translateIfKey(value, dict);

  // Arrays: map recursively
  if (Array.isArray(value)) return value.map((v) => translatePayload(v, dict));

  // Buffers / Dates / non-plain objects: leave as-is
  if (value instanceof Buffer || value instanceof Date) return value;

  // Plain objects: special-case translateKey/message first, then recurse others
  if (typeof value === 'object') {
    const out = {};

    // 1) Read raw fields without mutating them
    const rawTranslateKey = value.translateKey;
    const rawMessage = value.message;

    const hasKey = typeof rawTranslateKey === 'string' && /^key-sc_/i.test(rawTranslateKey);

    // 2) If there's a translateKey, compute message FIRST and DO NOT translate translateKey itself
    if (hasKey) {
      const translated = translateKey(rawTranslateKey, dict);

      // If 'message' exists:
      if (typeof rawMessage === 'string') {
        // If message is itself a key, translate it; else preserve as fallback and set translated message
        if (/^key-sc_/i.test(rawMessage)) {
          out.message = translateKey(rawMessage, dict);
        } else {
          out.message_fallback = rawMessage;
          out.message = translated;
        }
      } else {
        out.message = translated;
      }

      // Keep translateKey as the ORIGINAL key string for tracing
      out.translateKey = rawTranslateKey;
    } else if (typeof rawMessage === 'string') {
      // No translateKey: translate message only if it is a key
      out.message = translateIfKey(rawMessage, dict);
    }

    // 3) Recurse the rest of fields, skipping special ones we've already handled
    for (const [k, v] of Object.entries(value)) {
      if (k === 'translateKey' || k === 'message' || k === 'message_fallback') continue;
      out[k] = translatePayload(v, dict);
    }

    return out;
  }

  // Everything else (numbers, booleans, etc.)
  return value;
}

/** Express middleware to attach dict and wrap res.json */
function i18nMiddleware(req, res, next) {
  try {
    const lang = detectLang(req);
    const dict = loadTranslations(lang);
    res.locals.lang = lang;
    res.locals.dict = dict;

    const originalJson = res.json.bind(res);

    res.json = (body) => {
      try {
        // Translate just-in-time, preserving translateKey and populating message
        const translated = translatePayload(body, dict);
        return originalJson(translated);
      } catch (e) {
        // Fail open: never block responses if i18n fails
        return originalJson(body);
      }
    };

    next();
  } catch {
    next();
  }
}

module.exports = { i18nMiddleware };
