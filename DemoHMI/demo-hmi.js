/*****************************************************************************
 * Demo HMI Live Simulator
 * - Reads optional layout.json to collect tag IDs
 * - Seeds defaults based on tag name patterns
 * - Produces live-changing values (booleans, counters, analogs with jitter)
 * - Implements TOHMI_CRC_Handshake: 1..300 every 1s, then 3s pause, repeat
 * - Exposes your existing liveDataAPI endpoints for the mobile app
 ****************************************************************************/

// Core deps
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');

// --- Server & registry ------------------------------------------------------
const SERVER_NAME = os.hostname();
const socketPort = 5000;

const componentsRegistry = {
  SERVER_NAME,
  HEARTBEAT: 'TOHMI_CRC_Handshake',
  IIR: true,
  robotProvider: 'yaskawa',     // "yaskawa" | "fanuc"
  robot_perFeedpoint: [1],
  robotJobs: 1,                 // 1 palletize, 2 depalletize, 3 both
  totalServoDrs: 0,
  totalLTs: 0,
  totalAirUnits: 0,
  totalSolenoids: 0,
  totalSRelays: 0,
  totalSGates: 0,
  totalESTOPs: 1,
  totalLScanners: 0,
  totalLScannersWarnings: 0,
  totalLCurtains: 1,
  LC_overriding: [],
  totalVFDs: 3,                
  blowerVFDs: [],              
  stations_perFeedpoint: [[1]]
};

// --- Global data buffer -----------------------------------------------------
const myDataAll = {};
myDataAll['TOHMI_totalFeedpoints'] = componentsRegistry.stations_perFeedpoint.length;
for (let i = 0; i < componentsRegistry.stations_perFeedpoint.length; i++) {
  myDataAll[`TOHMI_Feedpoint${i + 1}_totalStations`] = componentsRegistry.stations_perFeedpoint[i].length;
}

// --- Helpers ----------------------------------------------------------------
/** Simple random helper */
const rand = (min, max) => Math.random() * (max - min) + min;
/** Jitter analog value a little bit */
const jitter = (value, pct = 0.03) => {
  // +/- pct percent noise
  const delta = value * pct;
  return value + rand(-delta, delta);
};
/** Clamp number */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
/** Toggle 0/1 */
const flip01 = (v) => (v ? 0 : 1);
/** Pick from list */
const pick = (arr) => arr[Math.floor(rand(0, arr.length))];

/** Default value for unknown tag based on naming pattern */
function defaultValueForTag(tag) {
  // Alarms/Warnings default OFF
  if (/^(ALARM_|WARNING_)/.test(tag)) return 0;

  // Handshake starts in 1
  if (tag === 'TOHMI_CRC_Handshake') return 1;

  // Common binary signals ON to show activity
  if (/_Start$|_servoOn$|_remoteMode$|_teachMode$|_Avail$|_Open$|_Switch$|_Lock$|_Auto$|_infeedReady$|_outfeedReady$|_Fwd$/i.test(tag)) return 1;

  // Robot numeric live stats
  if (/R\d+_currentSpeed$/i.test(tag)) return 80;
  if (/R\d+_dailyPicks$/i.test(tag)) return 350;
  if (/R\d+_liveCycle$/i.test(tag)) return 30;
  if (/R\d+_Timer$/i.test(tag)) return 10;
  if (/R\d+_Position$/i.test(tag)) return 1;

  // Timers, counters
  if (/(_Timer|_totalProducts|_jobsDone|_queueCount)$/i.test(tag)) return 0;

  // VFD analogs (x10 for one decimal place semantics if present)
  if (/_Volt$/.test(tag)) return 2300; // e.g., 230.0V scaled 10x
  if (/_Amp$/.test(tag))  return 280;  // e.g., 2.80A scaled 100x
  if (/_Freq$/.test(tag)) return 600;  // e.g., 60.0Hz scaled 10x

  // Photoeyes & digital IOs default ON
  if (/^(TOHMI_PE|din_|dout_)\d+/.test(tag)) return 1;

  // Recipe strings
  if (/projectName$/i.test(tag)) return 'Demo Project A';

  // Current/Total pairs
  if (/current(Job|Layer)$/i.test(tag)) return 1;
  if (/total(Layers|DropsAmount)$/i.test(tag)) return 10;

  // Safe default
  return 0;
}

/** Collect tags from layout.json (fields + alarms) */
function collectTagsFromLayout(layoutObj) {
  // Walk pages/sections/widgets/props and extract tag references in many shapes
  const tags = new Set();

  const walkField = (field) => {
    // field can be string tagId, object with tagId/currentTagId/totalTagId/array of strings, or nested arrays
    if (typeof field === 'string') {
      tags.add(field);
    } else if (Array.isArray(field)) {
      field.forEach(walkField);
    } else if (field && typeof field === 'object') {
      // common keys: tagId, currentTagId, totalTagId
      if (field.tagId) walkField(field.tagId);
      if (field.currentTagId) walkField(field.currentTagId);
      if (field.totalTagId) walkField(field.totalTagId);
      // Also allow label or other keys that might be arrays/objects containing tag-like strings
      Object.values(field).forEach((v) => {
        if (Array.isArray(v)) v.forEach(walkField);
      });
    }
  };

  const walkWidget = (w) => {
    if (!w || !w.props) return;
    const { fields, alarms } = w.props;

    if (fields) walkField(fields);
    if (alarms) walkField(alarms);
  };

  const walkSection = (s) => {
    if (!s.widgets) return;
    s.widgets.forEach(walkWidget);
  };

  const walkPage = (p) => {
    if (!p.sections) return;
    p.sections.forEach(walkSection);
  };

  if (layoutObj && Array.isArray(layoutObj.pages)) {
    layoutObj.pages.forEach(walkPage);
  }

  // Always ensure heartbeat exists
  tags.add(componentsRegistry.HEARTBEAT);

  return [...tags];
}

// --- Items to monitor (fallback minimal set; layout will augment) ----------
let itemsToMonitor = [
  'TOHMI_CRC_Handshake',
  'TOHMI_Module1_autoMode',
  'TOHMI_Module1_Start',
  'TOHMI_Module1_Pause',
  'TOHMI_Module1_dryRun',
  'TOHMI_Module1_activeAlarm',
  'TOHMI_Module1_activeWarning',
  'TOHMI_R1_servoOn',
  'TOHMI_R1_remoteMode',
  'TOHMI_R1_Position',
  'TOHMI_R1_currentSpeed',
  'TOHMI_R1_liveCycle',
  'TOHMI_R1_Timer',
  'TOHMI_R1_dailyPicks',
  'TOHMI_PE1',
  'TOHMI_PE2',
  'TOHMI_PE3',
  'ALARM_Server1_commLoss',
  'WARNING_Module1_manualMode',
  'ALARM_VFD1_Fault',
  'ALARM_VFD1_commLoss',
  'TOHMI_VFD1_Start',
  'TOHMI_VFD1_Fwd',
  'TOHMI_VFD1_Volt',
  'TOHMI_VFD1_Amp',
  'TOHMI_VFD1_Freq',
  'TOHMI_VFD1_Timer'
];

// Try to augment tags from layout.json if present
const layoutPath = path.join(process.cwd(), './liveDataAPI/layout.json');
if (fs.existsSync(layoutPath)) {
  try {
    const raw = fs.readFileSync(layoutPath, 'utf8');
    const layout = JSON.parse(raw);
    const collected = collectTagsFromLayout(layout);
    
    // Merge unique
    itemsToMonitor = Array.from(new Set([...itemsToMonitor, ...collected]));
    console.log(`Collected ${collected.length} tags from layout.json (total now ${itemsToMonitor.length}).`);
  } catch (e) {
    console.warn('Failed to parse layout.json, continuing with fallback tags:', e.message);
  }
} else {
  console.log('layout.json not found; running with fallback tag set (you can drop your layout as layout.json).');
}

// --- Seed data --------------------------------------------------------------
function seedMockData() {
  for (const tag of itemsToMonitor) {
    if (!(tag in myDataAll)) {
      myDataAll[tag] = defaultValueForTag(tag);
    }
  }

  // Seed VFDs 1..N because layout muestra 1..3
  for (let i = 1; i <= componentsRegistry.totalVFDs; i++) {
    myDataAll[`TOHMI_VFD${i}_Volt`]  = defaultValueForTag('X_Volt'); // 2300
    myDataAll[`TOHMI_VFD${i}_Amp`]   = defaultValueForTag('X_Amp');  // 280
    myDataAll[`TOHMI_VFD${i}_Freq`]  = defaultValueForTag('X_Freq'); // 600
    myDataAll[`TOHMI_VFD${i}_Timer`] = 0;
    myDataAll[`TOHMI_VFD${i}_Start`] = i % 2;
    myDataAll[`TOHMI_VFD${i}_Fwd`]   = 1;
    myDataAll[`ALARM_VFD${i}_Fault`] = 0;
    myDataAll[`ALARM_VFD${i}_commLoss`] = 0;
  }

  // Station/Recipe sample values (visible in your layout)
  myDataAll['Recipe_Feedpoint1_projectName'] = 'Demo Project A';
  myDataAll['Recipe_Feedpoint1_currentLayer'] = 1;
  myDataAll['Recipe_Feedpoint1_totalLayers'] = 6;
  myDataAll['TOHMI_Feedpoint1_currentJob'] = 1;
  myDataAll['Recipe_Feedpoint1_totalDropsAmount'] = 12;
  myDataAll['Recipe_Feedpoint1_layerSeparator'] = 0;
  myDataAll['Recipe_Feedpoint1_pickProductsAmount'] = 4;
  myDataAll['Recipe_Feedpoint1_dropProductsAmount'] = 4;
  myDataAll['TOHMI_Station1_totalStats'] = 0;
  myDataAll['TOHMI_Station1_jobsDone'] = 0;
  myDataAll['TOHMI_Station1_totalProducts'] = 0;

  // Alarms referenced in alarm page start OFF
  [
    'ALARM_R1_Error','ALARM_R1_commLoss','ALARM_R1_remoteDisabled','ALARM_R1_productDropped','ALARM_R1_safeDrop','ALARM_R1_failedPick',
    'ALARM_CSR1_Error','ALARM_CSR1_commLoss','ALARM_DI1_commLoss','ALARM_DO1_commLoss',
    'WARNING_R1_safespeed',
    'ALARM_ESTOP1','ALARM_airPressure1',
    'ALARM_VFD1_Fault','ALARM_VFD2_Fault','ALARM_VFD3_Fault',
    'ALARM_VFD1_commLoss','ALARM_VFD2_commLoss','ALARM_VFD3_commLoss',
    'ALARM_Server1_commLoss',
    'WARNING_Station1_containerAbsent','WARNING_Station1_removeContainer',
    'ALARM_Station1_removeContainer','ALARM_Station1_containerAbsent',
    'ALARM_Feedpoint1_queueFault','ALARM_Feedpoint2_queueFault','ALARM_Feedpoints_queueFault',
    'WARNING_Module1_manualMode'
  ].forEach(t => { if (!(t in myDataAll)) myDataAll[t] = 0; });

  // Photoeyes 1..9 used in indicators page
  for (let i = 1; i <= 9; i++) {
    const k = `TOHMI_PE${i}`;
    if (!(k in myDataAll)) myDataAll[k] = 1;
  }
}

// --- Live dynamics ----------------------------------------------------------
/** Handshake: 1..300 every 1s, then wait 3s, repeat */
function startHandshake() {
  let hb = 1;
  let active = true;
  myDataAll[componentsRegistry.HEARTBEAT] = hb;

  setInterval(() => {
    if (!active) return;
    hb++;
    if (hb > 300) {
      active = false;
      setTimeout(() => {
        hb = 1;
        active = true;
      }, 3000); // wait 3s then restart
    }
    myDataAll[componentsRegistry.HEARTBEAT] = active ? hb : 300;
  }, 1000);
}

/** Periodic small changes for analogs and toggles for digitals */
function startValueAnimators() {
   setInterval(() => {
    // Module modes / start-pause toggles to visualize UI changes
    myDataAll['TOHMI_Module1_autoMode'] = flip01(myDataAll['TOHMI_Module1_autoMode']);
    myDataAll['TOHMI_Module1_Start'] = flip01(myDataAll['TOHMI_Module1_Start']);
    myDataAll['TOHMI_Module1_Pause'] = flip01(myDataAll['TOHMI_Module1_Pause']);

    // Photoeyes pseudo-random blinks (not all at once)
    for (let i = 1; i <= 9; i++) {
      if (Math.random() < 0.25) myDataAll[`TOHMI_PE${i}`] = flip01(myDataAll[`TOHMI_PE${i}`]);
    }

    // Robot live counters
    myDataAll['TOHMI_R1_Timer'] = (myDataAll['TOHMI_R1_Timer'] || 0) + 1;
    if (Math.random() < 0.5) myDataAll['TOHMI_R1_dailyPicks'] = (myDataAll['TOHMI_R1_dailyPicks'] || 0) + 1;
    if (Math.random() < 0.3) myDataAll['TOHMI_R1_liveCycle'] = (myDataAll['TOHMI_R1_liveCycle'] || 0) + 1;

    // Station/Recipe progress
    if (Math.random() < 0.35) {
      myDataAll['TOHMI_Station1_totalProducts'] = (myDataAll['TOHMI_Station1_totalProducts'] || 0) + 1;
    }
    if (Math.random() < 0.15) {
      myDataAll['TOHMI_Station1_jobsDone'] = (myDataAll['TOHMI_Station1_jobsDone'] || 0) + 1;
    }
    // Current layer advances occasionally (wrap at totalLayers)
    if (Math.random() < 0.08) {
      const totalLayers = myDataAll['Recipe_Feedpoint1_totalLayers'] || 6;
      const next = (myDataAll['Recipe_Feedpoint1_currentLayer'] || 1) + 1;
      myDataAll['Recipe_Feedpoint1_currentLayer'] = next > totalLayers ? 1 : next;
    }

    // Randomize some warnings/alarms briefly
    ['ALARM_R1_Error','ALARM_R1_productDropped','ALARM_R1_safeDrop','ALARM_VFD1_Fault',
     'ALARM_VFD2_Fault','ALARM_VFD3_Fault','ALARM_Server1_commLoss',
     'WARNING_Module1_manualMode','WARNING_Station1_containerAbsent'
    ].forEach(tag => {
      if (Math.random() < 0.08) myDataAll[tag] = 1;
      if (Math.random() < 0.20) myDataAll[tag] = 0;
    });
  }, 1500);

  // Analog drift (1s): VFD metrics & robot speed
  setInterval(() => {
    for (let i = 1; i <= componentsRegistry.totalVFDs; i++) {
      const vKey = `TOHMI_VFD${i}_Volt`;
      const aKey = `TOHMI_VFD${i}_Amp`;
      const fKey = `TOHMI_VFD${i}_Freq`;
      const tKey = `TOHMI_VFD${i}_Timer`;

      myDataAll[vKey] = clamp(Math.round(jitter(myDataAll[vKey] || 2300, 0.02)), 2150, 2450); // 215.0V..245.0V
      myDataAll[aKey] = clamp(Math.round(jitter(myDataAll[aKey] || 280, 0.05)), 180, 420);    // 1.80A..4.20A
      myDataAll[fKey] = clamp(Math.round(jitter(myDataAll[fKey] || 600, 0.02)), 400, 650);    // 40.0..65.0Hz
      myDataAll[tKey] = (myDataAll[tKey] || 0) + 1;
    }

    // Robot speed fluctuates between 50..100
    const sp = clamp(Math.round(jitter(myDataAll['TOHMI_R1_currentSpeed'] || 80, 0.1)), 50, 100);
    myDataAll['TOHMI_R1_currentSpeed'] = sp;

  }, 1000);

  setInterval(() => {
    for (let i = 1; i <= componentsRegistry.totalVFDs; i++) {
      if (Math.random() < 0.35) myDataAll[`TOHMI_VFD${i}_Start`] = flip01(myDataAll[`TOHMI_VFD${i}_Start`]);
      if (Math.random() < 0.20) myDataAll[`TOHMI_VFD${i}_Fwd`] = flip01(myDataAll[`TOHMI_VFD${i}_Fwd`]);
    }

    // Short commLoss spikes
    if (Math.random() < 0.15) {
      myDataAll['ALARM_VFD1_commLoss'] = 1;
      setTimeout(() => (myDataAll['ALARM_VFD1_commLoss'] = 0), 1500);
    }
  }, 10000);
}

// --- HTTP & API -------------------------------------------------------------
const app = express();
const serverAll = require('http').createServer(app);

// Attach your existing API adapter
const apiData = require('./liveDataAPI');
try {
  apiData.attach(app, {
    // Must return a string
    getOpcuaState: () => 'connected',
    // Current buffer
    getAllData: () => myDataAll,
    // Static "registry"
    getAllSettings: () => componentsRegistry
  });
  console.log('Initialized HMI API');
} catch (err) {
  console.error('Failed to initialize HMI API:', err);
}

// Root + static
app.get('/', (_req, res) => res.send('HMI Demo Simulator is running.'));
app.use(express.static(__dirname + '/'));

// Start server
serverAll.listen(socketPort, () => {
  console.log(`Server running. Listening on port ${socketPort}`);
});

// --- Boot sequence ----------------------------------------------------------
seedMockData();
startHandshake();
startValueAnimators();
console.info('Started in MOCK mode (layout-aware).');
