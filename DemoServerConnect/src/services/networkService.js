/*****************************************************************************
 * Local network discovery (stub). Replace with your scanner implementation.
 ****************************************************************************/
const os = require('os');
const fetch = require('node-fetch');
const { getPreferredIp } = require('../utils/network');
const AbortController = globalThis.AbortController || require('abort-controller');
const dotenv = require('dotenv');
dotenv.config();

const PORT = Number(process.env.SERVERCONNECT_PORT || 3000);
const ENDPOINT = process.env.SERVERCONNECT_STATUS_PATH || '/status';
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 1500);
const MAX_CONCURRENCY = Number(process.env.SCAN_MAX_CONCURRENCY || 64);

/** Scan all local /24 subnets for ServerConnect peers (deduped by IP).
 * @returns {Promise<Array<{ip:string,status:number,data:any}>>}
 */
async function scanAllNetworks() {
  const subnets = getLocalSubnets();
  const localIp = getPreferredIp();
  const all = [];
  for (const subnet of subnets) {
    const found = await scanSubnet(subnet,localIp);
    all.push(...found);
  }
  // Delete duplicate by IP
  const map = new Map();
  for (const item of all) if (!map.has(item.ip)) map.set(item.ip, item);
  return Array.from(map.values());
}

/** Return local private /24 prefixes (e.g., ['192.168.1.', '10.0.0.']).
 * @returns {string[]}
 */
function getLocalSubnets() {
  const ifaces = os.networkInterfaces();
  const subnets = new Set();
  for (const list of Object.values(ifaces)) {
    for (const cfg of list || []) {
      if (cfg.family !== 'IPv4' || cfg.internal) continue;
      const [a, b, c] = cfg.address.split('.');
      const aNum = Number(a);
      const isPrivate =
        aNum === 10 ||
        (aNum === 172 && Number(b) >= 16 && Number(b) <= 31) ||
        (aNum === 192 && Number(b) === 168);
      if (!isPrivate) continue; // skip non-private ranges
      subnets.add(`${a}.${b}.${c}.`);
    }
  }
  return [...subnets];
}

/** Probe a host's /status endpoint with timeout; returns minimal peer or null.
 * @param {string} ip
 * @returns {Promise<{ip:string,status:number,data:any}|null>}
 */
async function pingServer(ip) {
  const url = `http://${ip}:${PORT}${ENDPOINT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Use GET; /status should be cheap and unauthenticated (no secrets)
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return null;

    // Parse JSON when available; fallback to text (keep payload minimal)
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const data = ct.includes('application/json') && typeof res.json === 'function'
      ? await res.json()
      : (typeof res.text === 'function' ? await res.text() : null);

    return { ip, status: res.status, data };
  } catch (_) {
    return null; // swallow timeouts/connection errors
  } finally {
    clearTimeout(timer);
  }
}

/** Scan one /24 subnet with concurrency limit; skips this host's IP.
 * @param {string} subnet
 * @param {string} localIp
 * @returns {Promise<Array<{ip:string,status:number,data:any}>>}
 */
async function scanSubnet(subnet,localIp) {
  // Build IP queue 1..254 (skip .0 and .255)
  const queue = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}${i}`;
    if (localIp == ip) continue; // <-- skip own host IPs
    queue.push(ip);
  }
  const results = [];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
  while (queue.length) {
    const ip = queue.shift();
    const r = await pingServer(ip);
    if (r) results.push(r);
  }
  });

  await Promise.all(workers);
  return results;
}

module.exports = {
  scanAllNetworks,
  getLocalSubnets
};