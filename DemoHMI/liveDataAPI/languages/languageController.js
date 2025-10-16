/*****************************************************************************
 * @LastEditors           : Harold Garcia                                    *
 * @LastEditDate          : 2025-09-08 11:45:15                              *
 * @CopyRight             : DPPS                                             *
 ****************************************************************************/


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
  if (!rawKey.startsWith('key_')) return rawKey;

  const key = rawKey.slice(4).toLowerCase();
  const numbers = key.match(/\d+/g) || [];
  const generic = key.replace(/\d+/g, '#');

  let str = dict[key] ?? dict[generic];
  if (typeof str !== 'string') return rawKey;

  let out = str;
  numbers.forEach((n, i) => {
    out = out.replace(new RegExp(`#${i + 1}`, 'g'), n);
  });
  return out;
}

function translateDeep(value, dict) {
  if (value == null) return value;
  if (typeof value === 'string') return translateKey(value, dict);
  if (Array.isArray(value)) return value.map(v => translateDeep(v, dict));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = translateDeep(v, dict);
    }
    return out;
  }
  return value;
}

function translateLayout(layout, dict) {
  return translateDeep(layout, dict);
}

function translateMeta(metaObj, dict) {
  const out = {};
  for (const [tagId, meta] of Object.entries(metaObj || {})) {
    out[tagId] = translateDeep(meta, dict);
  }
  return out;
}

module.exports = { loadTranslations, translateKey, translateLayout, translateMeta };
