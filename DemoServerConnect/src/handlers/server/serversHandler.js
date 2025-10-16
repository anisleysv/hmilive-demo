/*****************************************************************************
 * Server-to-server utilities
 ****************************************************************************/
const { scanAllNetworks } = require('../../services/networkService');

/** Scan local network and return ServerConnect peers.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @returns {Promise<void>} 200 {servers} or 500 on error
 */
async function scanServers(_req, res) {
  try {
    const servers = await scanAllNetworks();
    return res.status(200).json({ servers });
  } catch (err) {
    // Keep error minimal; no sensitive details
    return res.status(500).json({ success: false, translateKey: 'key-sc_scan_failed' });
  }
}

module.exports = { scanServers };
