/*****************************************************************************
 * Print a QR code (terminal) for quick pairing from mobile
 ****************************************************************************/
const qrcode = require('qrcode-terminal');

/** Print a terminal QR code for quick mobile pairing.
 * @param {string} url
 * @returns {void}
 */
function generatePairingQR(url) {
  qrcode.generate(url, { small: true });
  console.log(`🔗 Pairing URL: ${url}`);
}

module.exports = {
  generatePairingQR
};