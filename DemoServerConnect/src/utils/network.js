/*****************************************************************************
 * Prefer Wi-Fi IPv4; fallback to any non-internal IPv4; else 127.0.0.1
 ****************************************************************************/
const os = require('os');

/** Return preferred LAN IPv4 (Wi-Fi first, else first non-internal, else 127.0.0.1).
 * @returns {string}
 */
function getPreferredIp() {
  const ifaces = os.networkInterfaces();

  // Prefer Wi-Fi / WLAN naming
  for (const name in ifaces) {
    const lower = name.toLowerCase();
    if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) {
      for (const cfg of ifaces[name] || []) {
        if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
      }
    }
  }
  // Fallback: first IPv4 non-internal
  for (const name in ifaces) {
    for (const cfg of ifaces[name] || []) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return '127.0.0.1';
}

module.exports = {
  getPreferredIp
};
