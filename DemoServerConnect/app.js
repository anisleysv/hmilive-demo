const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const os = require('os');

const hmiRoutes = require('./src/endpoints/hmi/status');
const serverRoutes = require('./src/endpoints/server/servers');

const { generatePairingQR } = require('./src/utils/qr');
const { getPreferredIp } = require('./src/utils/network');
const { i18nMiddleware } = require('./src/languages/languageController');

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = getPreferredIp() || process.env.BIND_HOST ; // exposed for LAN/Tunnel on purpose

// --- Middlewares ---
app.use(cors());           // Allow external devices / tunnel access
app.use(express.json());   // Parse JSON
app.use(i18nMiddleware);

// --- Routes (domain oriented) ---
app.use('/hmi', hmiRoutes);         // External → ServerConnect (protected by external auth)
app.use('/server', serverRoutes);   // Server-to-server utilities (scan/transfer)

// --- Root/status (minimal, no sensitive data) ---
app.get('/', (_req, res) => res.send('IIR ServerConnect API'));
app.get('/status', (_req, res) => {
  res.json({
    status: 'ok',
    name: 'IIR-SERVER-CONNECT',
    hostname: os.hostname(),
    version: '1.1.0',
    time: new Date().toISOString(),
  });
});

// --- Start ---
app.listen(PORT, HOST, () => {
  const baseLAN = `http://${HOST}:${PORT}`;
  console.log(`✅ ServerConnect running on ${baseLAN}`);
  // Display QR for quick pairing (PUBLIC_BASE_URL)
  generatePairingQR(baseLAN);
});
