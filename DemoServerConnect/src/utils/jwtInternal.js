/*****************************************************************************
 * HS256 JWT for internal DataHandler calls (ServerConnect ↔ DataHandler)
 ****************************************************************************/
const jwt = require('jsonwebtoken');
const { getServerId, deriveSharedSecret } = require('./identity.js');

const ISSUER = 'serverconnect';
const DATA_HANDLER_AUDIENCE_PREFIX = 'datahandler:';
const DATA_HMI_AUDIENCE_PREFIX = 'hmilive:';

/** Sign a short-lived internal HS256 JWT (issuer/audience bound to this server).
 * @param {Object} [payload={}]
 * @param {{expiresIn?: string}} [options]
 * @returns {string} JWT
 */
function signInternal(payload = {}, { expiresIn = '30s', audPrefix = 'datahandler'} = {}) {
  // Sign short-lived token bound to this server identity
  const key = deriveSharedSecret(); // Buffer
  const aud = `${audPrefix.includes('datahandler') ? 
              DATA_HANDLER_AUDIENCE_PREFIX : 
              DATA_HMI_AUDIENCE_PREFIX}${getServerId()}`;
  return jwt.sign(payload, key, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: aud,
    expiresIn,
  });
}

module.exports = {
  signInternal
};