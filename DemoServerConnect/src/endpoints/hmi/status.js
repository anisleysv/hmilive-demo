/*****************************************************************************
 * /hmi routes — tokens validated from mobile app (iir-dbi-api)
 ****************************************************************************/
const express = require('express');
const router = express.Router();
const { getHmiStructure, getHmiStatus, streamHmiData, streamHmiLogo } = require('../../handlers/hmi/hmiHandler');

// All HMI routes require mobile auth
router.get('/status', getHmiStatus);
router.get('/structure', getHmiStructure);
router.get('/data', streamHmiData);
router.get('/logo/stream', streamHmiLogo);


module.exports = router;
