/*****************************************************************************
 * /server endpoints — visible to LAN
 ****************************************************************************/
const express = require('express');
const router = express.Router();
const { scanServers } = require('../../handlers/server/serversHandler');

/** Register GET /server/scan → scanServers (LAN-visible peer scan).
 * @returns {void}
 */
router.get('/scan', scanServers);

module.exports = router;
