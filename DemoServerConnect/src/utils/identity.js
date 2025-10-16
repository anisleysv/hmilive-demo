/*****************************************************************************
 * Derives a stable server identity and a shared secret key from MAC/hostname
 * This is purposely simple and local-only per your security posture.
 ****************************************************************************/
const os = require('os');
const crypto = require('crypto');

/** Get first non-internal MAC (lowercased) or null.
 * @returns {string|null}
 */
function getPrimaryMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      // Skip internal and non-IPv4; prefer the first valid MAC
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac.toLowerCase();
      }
    }
  }
  return null;
}

/** Get OS hostname or null.
 * @returns {string|null}
 */
function getHostname() {
  return os.hostname() || null;
}

/** Resolve server ID: prefer MAC, then hostname, else 'unknown-server'.
 * @returns {string}
 */
function getServerId() {
  // Prefer MAC, fallback to hostname
  return getPrimaryMac() || getHostname() || 'unknown-server';
}

/** Derive 32-byte shared secret (SHA-256 of serverId + pepper) for HS256.
 * @returns {Buffer}
 */
function deriveSharedSecret() {
  // IMPORTANT (security note):
  // Derive a shared HS256 key from serverId; add a fixed pepper to avoid raw MAC-as-key.
  const serverId = getServerId();
  const pepper = 'iir-minimal-local-shared-key-v1'; // static pepper to avoid raw device id usage
  // Produce a 32-byte key (SHA-256)
  return crypto.createHash('sha256').update(`${serverId}:${pepper}`).digest(); // Buffer
}

module.exports = {
  getServerId,
  deriveSharedSecret,
};
