'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PARTICIPANTS_API_URL = process.env.PARTICIPANTS_API_URL || '';
const PARTICIPANTS_API_TOKEN = process.env.PARTICIPANTS_API_TOKEN || '';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PARTICIPANTS_FILE = path.join(DATA_DIR, 'participants.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const AD_DIR = path.join(__dirname, 'ADVERTISEMENT');
let adConfig = readJson(SETTINGS_FILE, { enabled: false, intervalMinutes: 3 });
let adStatus = { phase: 'unknown', phaseEndsAt: 0, adPending: false, adPlaying: false, viewerSeenAt: 0, estimatedAdAt: 0, note: 'Waiting for viewer connection' };
fs.mkdirSync(DATA_DIR, { recursive: true });
if (adConfig.enabled && !Number(adConfig.nextAdAt)) { adConfig.nextAdAt = Date.now() + Math.max(1, Number(adConfig.intervalMinutes)||3)*60000; writeJsonAtomic(SETTINGS_FILE, adConfig); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
const initial = readJson(STATE_FILE, {});
const state = {
  scores: Array.isArray(initial.scores) ? initial.scores : [],
  winners: Array.isArray(initial.winners) ? initial.winners : [],
  updatedAt: initial.updatedAt || new Date().toISOString()
};
let participants = readJson(PARTICIPANTS_FILE, []);
function saveState() { state.updatedAt = new Date().toISOString(); writeJsonAtomic(STATE_FILE, state); }
function saveParticipants() { writeJsonAtomic(PARTICIPANTS_FILE, participants); }
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 12 * 1024 * 1024) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function authorized(req, suppliedToken) {
  if (!ADMIN_TOKEN) return true; // Set ADMIN_TOKEN in Railway before public deployment.
  const header = req?.headers?.authorization || '';
  return header === `Bearer ${ADMIN_TOKEN}` || suppliedToken === ADMIN_TOKEN;
}
function listAds(){if(!fs.existsSync(AD_DIR))return [];return fs.readdirSync(AD_DIR,{withFileTypes:true}).filter(x=>x.isFile()&&/\.(mp4|webm|ogg|mov|m4v)$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name)).map(x=>({name:x.name,url:'/ADVERTISEMENT/'+encodeURIComponent(x.name)}));}
async function getParticipants() {
  if (!PARTICIPANTS_API_URL) return participants;
  const headers = {};
  if (PARTICIPANTS_API_TOKEN) headers.Authorization = `Bearer ${PARTICIPANTS_API_TOKEN}`;
  const response = await fetch(PARTICIPANTS_API_URL, { headers, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Registration API returned HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : (payload.participants || payload.results || payload.data || []);
  if (!Array.isArray(rows)) throw new Error('Registration API response is not a participant array');
  return rows.filter(row => row && typeof row === 'object' && String(row.school || row.School || row.schoolName || '').trim());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, service: 'cds-results', updatedAt: state.updatedAt });
  if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, {...state, adConfig, adStatus, serverNow: Date.now()});
  if (req.method === 'GET' && url.pathname === '/api/ads') return sendJson(res, 200, {ads:listAds()});
  if (req.method === 'GET' && url.pathname.startsWith('/ADVERTISEMENT/')) {
    const name=path.basename(decodeURIComponent(url.pathname.slice('/ADVERTISEMENT/'.length)));
    const file=path.join(AD_DIR,name); if(!fs.existsSync(file)||!fs.statSync(file).isFile())return sendJson(res,404,{error:'Ad not found'});
    const types={'.mp4':'video/mp4','.webm':'video/webm','.ogg':'video/ogg','.mov':'video/quicktime','.m4v':'video/mp4'};
    const stat=fs.statSync(file),range=req.headers.range;const type=types[path.extname(file).toLowerCase()]||'application/octet-stream';
    if(range){const m=/bytes=(\d*)-(\d*)/.exec(range);if(m){const start=m[1]?Number(m[1]):0,end=m[2]?Math.min(Number(m[2]),stat.size-1):stat.size-1;res.writeHead(206,{'Content-Type':type,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes'});return fs.createReadStream(file,{start,end}).pipe(res);}}
    res.writeHead(200,{'Content-Type':type,'Content-Length':stat.size,'Accept-Ranges':'bytes','Cache-Control':'no-store'});return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/participants') {
    try { return sendJson(res, 200, { participants: await getParticipants(), source: PARTICIPANTS_API_URL ? 'registration-api' : 'uploaded-import' }); }
    catch (err) { return sendJson(res, 502, { error: err.message, participants: [] }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/schools') {
    try {
      const rows = await getParticipants();
      const schools = [...new Set(rows.map(row => String(row.school || row.School || row.schoolName || row.school_name || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      return sendJson(res, 200, { schools, count: schools.length, source: PARTICIPANTS_API_URL ? 'registration-api' : 'uploaded-import' });
    } catch (err) {
      return sendJson(res, 502, { error: err.message, schools: [], count: 0 });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/participants') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    try {
      const body = await readBody(req); const rows = Array.isArray(body.participants) ? body.participants : [];
      if (!rows.length) return sendJson(res, 400, { error: 'No participant rows supplied' });
      participants = rows; saveParticipants(); return sendJson(res, 200, { ok: true, count: participants.length });
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/viewer.html' || url.pathname === '/host.html')) {
    const filename = url.pathname === '/host.html' ? 'host.html' : 'viewer.html';
    const file = path.join(__dirname, filename);
    if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(file).pipe(res); }
  }
  sendJson(res, 404, { error: 'Not found' });
});
const wss = new WebSocket.Server({ server });
function broadcast(message) { const raw = JSON.stringify(message); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(raw); }
function validWinner(w) { return w && typeof w.id === 'string' && typeof w.event === 'string' && typeof w.school === 'string' && typeof w.position === 'string' && typeof w.ageCategory === 'string'; }
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init-state', state, adConfig, adStatus, serverNow: Date.now() }));
  ws.send(JSON.stringify({ type: 'ad-schedule', adConfig, adStatus, serverNow: Date.now() }));
  ws.send(JSON.stringify({ type: 'ad-list', ads:listAds() }));
  ws.on('message', raw => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return ws.send(JSON.stringify({ type: 'error', message: 'Invalid message JSON' })); }
    const adminAction = ['score', 'winner', 'update-winner', 'delete-winner', 'clear-winners', 'clear-scores', 'ad-config'].includes(data.type);
    if (adminAction && !authorized(null, data.token)) return ws.send(JSON.stringify({ type: 'error', message: 'Admin authentication failed' }));
    if (data.type === 'ad-config' && data.config && typeof data.config.enabled === 'boolean') {
      adConfig = { enabled:data.config.enabled, intervalMinutes:Math.max(1,Math.min(240,Number(data.config.intervalMinutes)||3)), nextAdAt: data.config.enabled ? Date.now()+Math.max(1,Math.min(240,Number(data.config.intervalMinutes)||3))*60000 : 0 };
      if(!data.config.enabled){adStatus.adPending=false;adStatus.adPlaying=false;adStatus.estimatedAdAt=0;adStatus.note='Advertisements disabled';}
      writeJsonAtomic(SETTINGS_FILE,adConfig);broadcast({type:'ad-config',config:adConfig,adStatus,serverNow:Date.now()});broadcast({type:'ad-schedule',adConfig,adStatus,serverNow:Date.now()});
    } else if (data.type === 'viewer-status') {
      adStatus = { ...adStatus, phase: String(data.phase||'unknown'), phaseEndsAt: Number(data.phaseEndsAt)||0, adPending: !!data.adPending, adPlaying: !!data.adPlaying, viewerSeenAt: Date.now(), estimatedAdAt: Number(data.estimatedAdAt)||0, note: String(data.note||'') };
      broadcast({type:'viewer-status',adStatus,adConfig,serverNow:Date.now()});
    } else if (data.type === 'ad-started') {
      adStatus = { ...adStatus, phase:'ad', adPending:false, adPlaying:true, viewerSeenAt:Date.now(), estimatedAdAt:0, note:'Advertisement is playing' };
      broadcast({type:'viewer-status',adStatus,adConfig,serverNow:Date.now()});
    } else if (data.type === 'ad-finished') {
      const interval=Math.max(1,Math.min(240,Number(adConfig.intervalMinutes)||3));
      adConfig.nextAdAt=adConfig.enabled?Date.now()+interval*60000:0;
      adStatus = { ...adStatus, phase:'score', phaseEndsAt:0, adPending:false, adPlaying:false, viewerSeenAt:Date.now(), estimatedAdAt:0, note:'Advertisement finished; next interval started' };
      writeJsonAtomic(SETTINGS_FILE,adConfig);
      broadcast({type:'ad-schedule',adConfig,adStatus,serverNow:Date.now()});
    } else if (data.type === 'announcement-queue' && Number.isInteger(data.count)) {
      broadcast({type:'announcement-queue',count:Math.max(0,data.count),adPlaying:!!data.adPlaying});
    } else if (data.type === 'score' && Number.isInteger(data.index) && data.index >= 0 && typeof data.value === 'number' && Number.isFinite(data.value)) {
      state.scores[data.index] = data.value; saveState(); broadcast({ type: 'score', index: data.index, value: data.value });
    } else if (data.type === 'winner' && validWinner(data.winner)) {
      const winner = { ...data.winner, createdAt: data.winner.createdAt || new Date().toISOString() };
      state.winners.push(winner); saveState(); broadcast({ type: 'winner', winner, winners: state.winners });
    } else if (data.type === 'update-winner' && validWinner(data.winner)) {
      const index = state.winners.findIndex(w => w.id === data.winner.id); if (index < 0) return;
      state.winners[index] = { ...state.winners[index], ...data.winner, updatedAt: new Date().toISOString() }; saveState(); broadcast({ type: 'state', state });
    } else if (data.type === 'delete-winner' && typeof data.id === 'string') {
      state.winners = state.winners.filter(w => w.id !== data.id); saveState(); broadcast({ type: 'state', state });
    } else if (data.type === 'clear-winners') { state.winners = []; saveState(); broadcast({ type: 'state', state });
    } else if (data.type === 'clear-scores') { state.scores = []; saveState(); broadcast({ type: 'state', state }); }
  });
});
setInterval(() => broadcast({ type: 'ping', at: Date.now(), adConfig, adStatus }), 5000).unref();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`CDS Results server listening on ${PORT}`);
  if (!ADMIN_TOKEN) console.warn('WARNING: ADMIN_TOKEN is not set. Admin actions are unauthenticated.');
  if (!PARTICIPANTS_API_URL) console.log('No registration API configured; use Excel import in the host panel.');
});
