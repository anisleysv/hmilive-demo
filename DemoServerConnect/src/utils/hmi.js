/** Minimal SSE block parser: returns { type, data } where data is JSON if possible. */
function parseSSEEvent(block) {
  let type = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  const payload = dataLines.join('\n');
  let data = null;
  if (payload) { try { data = JSON.parse(payload); } catch { data = payload; } }
  return { type, data };
}

/** Detect recipe id tags (adjust if your source uses a different field). */
function isRecipeIdTag(tagId) {
  return /^Feedpoint\d+_recipeData1$/.test(tagId) || /^TOHMI_Feedpoint\d+_currentRecipe$/.test(tagId);
}
/** Detect currentJob tags (adjust patterns as needed for your HMI) */
function isCurrentJobTag(tagId) {
  return /^Feedpoint\d+_currentJob$/.test(tagId) || /^TOHMI_Feedpoint\d+_currentJob$/.test(tagId);
}

/** Extract feedpoint number from tagId, e.g., "Feedpoint3_..." -> 3 */
function feedpointFromTag(tagId) {
  const m = tagId.match(/Feedpoint(\d+)/);
  return m ? Number(m[1]) : null;
}

function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Build the key-value pairs to send via `path`
 * @returns {Array<{tagId:string, value:any, ts:number}>}
 */
function normalizeRecipePathUpdates(feedpoint, project) {
  const ts = Date.now();

  const {
    name = '',
    type = null,
    base = {},
    product = {},
    layers = [],
    totalDropsAmount = 0,
    totalPicksAmount = 0,
    totalProductsAmount = 0,
  } = project || {};

  // Product settings
  const settingsObj = typeof product.settings === 'string'
    ? safeJsonParse(product.settings, {})
    : (product.settings || {});

  const updates = [];

  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_totalPicksAmount`,   value: totalPicksAmount, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_totalDropsAmount`,   value: totalDropsAmount, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_totalProductsAmount`,   value: totalProductsAmount, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_totalLayers`,  value: Array.isArray(layers) ? layers.length : 0, ts });

  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_projectName`,     value: name || '', ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_projectTypeName`, value: type || String(type ?? ''), ts });

  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_baseWidth`,    value: base.width  ?? null, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_baseLength`,   value: base.length ?? null, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_baseHeight`,   value: base.height ?? null, ts });

  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_productType`,    value: product.type || '', ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_productWidth`,   value: product.width  ?? null, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_productLength`,  value: product.length ?? null, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_productHeight`,  value: product.height ?? null, ts });
  updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_productRadius`,  value: product.type !== 'rect' ? (product.radius ?? null) : null, ts });
  
  if (settingsObj && typeof settingsObj === 'object') {
    if (settingsObj.type) {
      updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_settingsType`, value: String(settingsObj.type), ts });
    }
    if (settingsObj.model) {
      updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_settingsModel`, value: String(settingsObj.model), ts });
    }
    if (settingsObj.color) {
      updates.push({ tagId: `Recipe_Feedpoint${feedpoint}_settingsColor`, value: String(settingsObj.color), ts });
    }
  }

  return updates;
}

function findJobInfoFromProject(project, jobNr) {
  // Return { layerNr, pickAmount, dropAmount, separator } or null
  if (!project || !Array.isArray(project.layers)) return null;
  for (const layerArr of project.layers) {
    if (!Array.isArray(layerArr)) continue;
    const hit = layerArr.find(el => Number(el?.recipeJobNr) === Number(jobNr));
    if (hit) {
      return {
        layerNr: Number(hit.layerNr ?? null),
        pickAmount: Number(hit.pickAmount ?? 0),
        dropAmount: Number(hit.dropAmount ?? 0),
        separator: Number(hit.separator ?? 0),
      };
    }
  }
  return null;
}

/** Build path updates for currentJob-derived info */
function normalizeCurrentJobPathUpdates(feedpoint, jobInfo) {
  const ts = Date.now();
  const { layerNr = null, pickAmount = null, dropAmount = null, separator = null } = jobInfo || {};

  return [
    { tagId: `Recipe_Feedpoint${feedpoint}_currentLayer`,   value: layerNr,   ts },
    { tagId: `Recipe_Feedpoint${feedpoint}_pickProductsAmount`, value: pickAmount, ts },
    { tagId: `Recipe_Feedpoint${feedpoint}_dropProductsAmount`, value: dropAmount, ts },
    { tagId: `Recipe_Feedpoint${feedpoint}_layerSeparator`,  value: separator,  ts },
  ];
}

/** Format Date to "YYYY-MM-DD HH:mm:ss.SSS" in server local time */
function formatLocalSql(d) {
  const pad = (n, s = 2) => String(n).padStart(s, '0');
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const SSS = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}.${SSS}`;
}

module.exports = {
  parseSSEEvent,
  isRecipeIdTag,
  isCurrentJobTag,
  feedpointFromTag,
  normalizeRecipePathUpdates,
  findJobInfoFromProject,
  normalizeCurrentJobPathUpdates,
  formatLocalSql
};
