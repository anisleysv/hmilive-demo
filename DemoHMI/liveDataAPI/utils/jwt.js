/*****************************************************************************
 * @LastEditors           : Harold Garcia                                    *
 * @LastEditDate          : 2025-08-18 16:03:05                              *
 * @CopyRight             : DPPS                                             *
 ****************************************************************************/

/*****************************************************************************
 * Minimal HS256 JWT helpers for internal calls (ServerConnect <-> DataHandler)
 ****************************************************************************/
const jwt = require('jsonwebtoken');
const { getServerId, deriveSharedSecret } = require('./identity');

const ISSUER = 'serverconnect'; // kept simple; both sides must align
const AUDIENCE_PREFIX = 'hmilive:'; // audience ties token to this machine

/** Verify internal HS256 JWT (issuer/audience bound to this server; throws on invalid).
 * @param {string} token
 * @returns {Object} Decoded claims
 */
function verifyInternal(token) {
  const key = deriveSharedSecret();
  const aud = `${AUDIENCE_PREFIX}${getServerId()}`;
  console.log("aud: ",aud);
  
  // Throws on invalid token; caller should catch and 401
  const decoded = jwt.verify(token, key, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: aud,
    clockTolerance: 5, // seconds skew allowed
  });
  return decoded;
}

module.exports = {verifyInternal};
