/*****************************************************************************
 * HMI handlers — protected by authMobile middleware (token already checked)
 ****************************************************************************/
const { getHmiStatus, getHmiStructure, openHmiSse, getHmiLogo } = require('../../services/hmiService');

/** GET /hmi/status -> pass-through hmi-live /status */
async function getHmiStatusHandler(_req, res) {
  try {
    const r = await getHmiStatus();
    return res.status(r.status).json(r.data);
  } catch (err) {
    const status = err.status || 502;
    return res.status(status).json({ success: false, translateKey: 'key-sc_hmi_live_status_error', detail: err.data || err.message });
  }
}

/** GET /hmi/structure -> pass-through hmi-live /hmi-structure */
async function getHmiStructureHandler(_req, res) {
  try {
    const lang = (_req.query?.lang && String(_req.query.lang)) || 'en';
    const r = await getHmiStructure({lang});
    return res.status(r.status).json(r.data);
  } catch (err) {
    const status = err.status || 502;
    return res.status(status).json({ success: false, translateKey: 'key-sc_hmi_live_structure_error', detail: err.data || err.message });
  }
}


/**
 * GET /hmi/data -> SSE proxy + enrichment
 * - Opens upstream SSE to hmi-live (/hmi-data)
 * - Forwards byte chunks to the client as-is
 * - Parses 'patch' events to detect recipe id changes and emits 'recipe' on change
 * - Aborts upstream and clears per-connection state when client disconnects
 */
async function streamHmiData(_req, res) {
  // Prepare SSE response for the mobile client
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // avoid proxy buffering

  // Optional initial comment to open the stream promptly
  res.write(': connected\n\n');

  // Per-connection memory
  const lastIdByFeedpoint = new Map();   
  let upstream, controller;
  try {
    const opened = await openHmiSse();
    upstream = opened.response;
    controller = opened.controller;
    // Pipe upstream SSE bytes to client, and also inspect to enrich on-the-fly
    upstream.body.on('data', async (chunk) => {
      // 1) Low-latency passthrough
      try { res.write(chunk); } catch (_) {}
    });

    upstream.body.on('end', () => {
      try { 
        res.end(); 
      } catch {}
    });
    upstream.body.on('error', () => {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ translateKey: 'key-sc_upstream_error' })}\n\n`);
      } finally {
        try { 
          res.end(); 
        } catch {}
      }
    });

    // Clean up when client disconnects
    res.on('close', () => {
      // Abort upstream and clear per-connection state
      try { controller.abort(); } catch (_) {}
    });

  } catch (err) {
    // If upstream cannot be opened, return a one-shot error SSE and close
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ translateKey: 'key-sc_cannot_reach_hmi_live', detail: err.message })}\n\n`);
    } finally {
      res.end();
    }
  }
}

/**
 * GET /hmi/logo/stream
 * - Proxies HMI logo image to the mobile client
 * - Preserves cache headers (ETag, Last-Modified) and supports 304 responses
 */
async function streamHmiLogo(req, res) {
  try {
    // Forward standard revalidation headers from the client
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];

    // Ask HMI for the logo (as a stream)
    const upstream = await getHmiLogo({ ifNoneMatch, ifModifiedSince });
    
    // Mirror status code (200 or 304, etc.)
    res.status(upstream.status);

    // Pass through important headers
    const pass = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-length'];
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // HEAD or 304 -> no body
    if (upstream.status === 304 || req.method === 'HEAD') {
      return res.end();
    }

    // Stream bytes to the client
    if (upstream.body) {
      upstream.body.on('error', () => { try { res.end(); } catch {} });
      upstream.body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    return res.status(err.status || 502).json({
      success: false,
      translateKey: 'key-sc_logo_upstream_error',
      detail: err.data || err.message
    });
  }
}

module.exports = {
  getHmiStatus: getHmiStatusHandler,
  getHmiStructure: getHmiStructureHandler,
  streamHmiData, streamHmiLogo
};
