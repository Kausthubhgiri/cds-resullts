/* CDS Sports Meet results service. Node 18+ */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogg', '.mov', '.m4v']);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.mp4':'video/mp4','.webm':'video/webm','.ogg':'video/ogg','.mov':'video/quicktime','.m4v':'video/x-m4v'};
let state = { scores: [], winners: [], schools: [] };
let settings = { enabled:false, intervalMinutes:3, nextAdAt:0 };
let participants = [];
let presentation = { active:false, stage:'idle', school:'', position:'', queue:[], current:null, video:null, startedAt:0 };

function json(res, code, body) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); }
function safeName(value) { return String(value || '').trim().slice(0, 200); }
async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJson(file, value) { await fsp.mkdir(DATA, {recursive:true}); await fsp.writeFile(file, JSON.stringify(value, null, 2)); }
async function load() {
  state = {...state, ...(await readJson(path.join(DATA,'state.json'), {}))};
  participants = await readJson(path.join(DATA,'participants.json'), []);
  settings = {...settings, ...(await readJson(path.join(DATA,'settings.json'), {}))};
  presentation = {...presentation, ...(await readJson(path.join(DATA,'presentation.json'), {}))};
  // A restart must not leave a projector locked in an orphaned presentation.
  if (presentation.active) { presentation = {active:false,stage:'idle',school:'',position:'',queue:[],current:null,video:null,startedAt:0}; await savePresentation(); }
}
const saveState = () => writeJson(path.join(DATA,'state.json'), state);
const saveParticipants = () => writeJson(path.join(DATA,'participants.json'), participants);
const saveSettings = () => writeJson(path.join(DATA,'settings.json'), settings);
const savePresentation = () => writeJson(path.join(DATA,'presentation.json'), presentation);
function schools(rows=participants) { return [...new Set([...(state.schools || []), ...rows.map(p=>safeName(p.school))].filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
async function liveParticipants() {
  const endpoint = process.env.PARTICIPANTS_API_URL;
  if (!endpoint) return { participants, source:'saved participants' };
  try {
    const headers = {accept:'application/json'};
    if (process.env.PARTICIPANTS_API_TOKEN) headers.authorization = `Bearer ${process.env.PARTICIPANTS_API_TOKEN}`;
    const response = await fetch(endpoint, {headers, signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error(`Registration API returned ${response.status}`);
    const body = await response.json();
    const rows = Array.isArray(body) ? body : (body.participants || body.results || body.data || []);
    if (!Array.isArray(rows)) throw new Error('Registration API response is not a participant list');
    return {participants:rows,source:'registration API'};
  } catch (error) { console.warn('Registration API unavailable; using saved participants:', error.message); return {participants,source:'saved participants (registration API unavailable)'}; }
}
async function videos(folder, prefix) { try { const entries = await fsp.readdir(path.join(ROOT,folder), {withFileTypes:true}); return entries.filter(e=>e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>({name:e.name,url:`/${prefix}/${encodeURIComponent(e.name)}`})); } catch { return []; } }
async function winnerVideo() { return (await videos('WINNERS','media/winners'))[0] || null; }

const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/health') return json(res,200,{ok:true});
  if (pathname === '/api/state') return json(res,200,{...state,presentation});
  if (pathname === '/api/schools') { const source=await liveParticipants(); return json(res,200,{schools:schools(source.participants),source:source.source}); }
  if (pathname === '/api/ads') return json(res,200,{ads:await videos('ADVERTISEMENT','media/ads')});
  if (pathname === '/api/winner-video') return json(res,200,{video:await winnerVideo()});
  if (pathname === '/api/participants') {
    if (req.method === 'GET') return json(res,200,await liveParticipants());
    if (req.method === 'POST') {
      if (!isAdminHeader(req)) return json(res,401,{error:'Unauthorized'});
      let raw=''; req.on('data',c=>raw+=c); req.on('end',async()=>{ try { const body=JSON.parse(raw); if(!Array.isArray(body.participants)) throw new Error('participants must be an array'); participants=body.participants; await saveParticipants(); broadcast({type:'state',state,adConfig:settings,presentation,serverNow:Date.now()}); json(res,200,{ok:true,count:participants.length}); } catch(e) { json(res,400,{error:e.message}); } }); return;
    }
    return json(res,405,{error:'Method not allowed'});
  }
  const media = pathname.match(/^\/media\/(ads|winners)\/([^/]+)$/);
  if (media) return streamMedia(res, req, media[1] === 'ads' ? 'ADVERTISEMENT' : 'WINNERS', media[2]);
  const file = pathname === '/' ? 'viewer.html' : pathname.slice(1);
  if (!['host.html','viewer.html'].includes(file)) return json(res,404,{error:'Not found'});
  try { const data=await fsp.readFile(path.join(ROOT,file)); res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); res.end(data); } catch { json(res,404,{error:'Not found'}); }
});
function isAdminHeader(req) { const auth=req.headers.authorization || ''; return !ADMIN_TOKEN || auth === `Bearer ${ADMIN_TOKEN}`; }
async function streamMedia(res, req, folder, encoded) {
  const name = path.basename(encoded); if (name !== encoded || !VIDEO_EXT.has(path.extname(name).toLowerCase())) return json(res,404,{error:'Not found'});
  const file = path.join(ROOT,folder,name);
  try { const stat=await fsp.stat(file); const total=stat.size; const type=MIME[path.extname(name).toLowerCase()]||'application/octet-stream'; const range=req.headers.range;
    if (!range) { res.writeHead(200,{'Content-Type':type,'Content-Length':total,'Accept-Ranges':'bytes','Cache-Control':'no-cache'}); fs.createReadStream(file).pipe(res); return; }
    const match=/bytes=(\d*)-(\d*)/.exec(range); if(!match) {res.writeHead(416,{'Content-Range':`bytes */${total}`}); return res.end();}
    const start=match[1] ? Number(match[1]) : 0, end=match[2] ? Math.min(Number(match[2]),total-1) : total-1;
    if(start> end || start>=total) {res.writeHead(416,{'Content-Range':`bytes */${total}`}); return res.end();}
    res.writeHead(206,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${total}`,'Cache-Control':'no-cache'}); fs.createReadStream(file,{start,end}).pipe(res);
  } catch { json(res,404,{error:'Video not found'}); }
}
const wss = new WebSocketServer({server});
function send(ws,payload){ if(ws.readyState===ws.OPEN) ws.send(JSON.stringify(payload)); }
function broadcast(payload){ for(const client of wss.clients) send(client,payload); }
function publishState(){ broadcast({type:'state',state,adConfig:settings,presentation,serverNow:Date.now()}); }
function admin(message) { return !ADMIN_TOKEN || message.token === ADMIN_TOKEN; }
wss.on('connection', ws => { send(ws,{type:'init-state',state,adConfig:settings,presentation,serverNow:Date.now()}); videos('ADVERTISEMENT','media/ads').then(ads=>send(ws,{type:'ad-list',ads})); winnerVideo().then(video=>send(ws,{type:'winner-video',video}));
  ws.on('message', async buf => { let m; try {m=JSON.parse(String(buf));} catch{return;}
    if (m.type === 'viewer-status' || m.type === 'announcement-queue' || m.type === 'ad-started' || m.type === 'ad-finished') { broadcast({...m,serverNow:Date.now()}); return; }
    if (m.type === 'presentation-video-ended') { if(presentation.active && presentation.stage==='video') { if(presentation.queue.length){presentation.current=presentation.queue.shift();presentation.school=presentation.current.school;presentation.position=presentation.current.position;presentation.stage='school';}else presentation.stage='select'; await savePresentation(); broadcast({type:'presentation',presentation,serverNow:Date.now()}); } return; }
    if (m.type === 'presentation-next') { if(presentation.active && presentation.stage==='school') { if(presentation.queue.length){presentation.current=presentation.queue.shift();presentation.school=presentation.current.school;presentation.position=presentation.current.position;presentation.stage='school';}else presentation.stage='complete'; await savePresentation(); broadcast({type:'presentation',presentation,serverNow:Date.now()}); } return; }
    if (!admin(m)) { send(ws,{type:'error',message:'Unauthorized admin command'}); return; }
    try {
      if (m.type === 'score') { const i=Number(m.index), v=Number(m.value); if(!Number.isInteger(i)||!Number.isFinite(v)) throw new Error('Invalid score'); state.scores[i]=v; await saveState(); broadcast({type:'score',index:i,value:v,serverNow:Date.now()}); return; }
      if (m.type === 'winner' || m.type === 'update-winner') { if(!m.winner?.id) throw new Error('Winner is required'); const at=state.winners.findIndex(w=>w.id===m.winner.id); if(at>=0)state.winners[at]=m.winner;else state.winners.push(m.winner); await saveState(); broadcast({type:'winner',winner:m.winner,winners:state.winners,serverNow:Date.now()}); return; }
      if (m.type === 'delete-winner') { state.winners=state.winners.filter(w=>w.id!==m.id); await saveState(); publishState(); return; }
      if (m.type === 'clear-scores') { state.scores=[]; await saveState(); publishState(); return; }
      if (m.type === 'clear-winners') { state.winners=[]; await saveState(); publishState(); return; }
      if (m.type === 'ad-config') { settings={enabled:!!m.config?.enabled,intervalMinutes:Math.max(1,Math.min(240,Number(m.config?.intervalMinutes)||3)),nextAdAt:Date.now()+Math.max(1,Math.min(240,Number(m.config?.intervalMinutes)||3))*60000}; await saveSettings(); broadcast({type:'ad-config',config:settings,adConfig:settings,serverNow:Date.now()}); return; }
      if (m.type === 'presentation-start') { const video=await winnerVideo(); if(!video) throw new Error('No supported video found in the WINNERS folder'); presentation={active:true,stage:'video',school:'',position:'',queue:[],current:null,video,startedAt:Date.now()}; await savePresentation(); broadcast({type:'presentation',presentation,serverNow:Date.now()}); return; }
      if (m.type === 'presentation-queue') { const school=safeName(m.school),position=safeName(m.position); const registration=await liveParticipants(); if(!presentation.active) throw new Error('Start the congratulations presentation first'); if(!schools(registration.participants).includes(school)) throw new Error('Select a registered school'); if(!['1st Place','2nd Place','3rd Place','Champion','Overall Champion','Special Award'].includes(position)) throw new Error('Select a valid position'); presentation.queue.push({school,position}); await savePresentation(); broadcast({type:'presentation',presentation,serverNow:Date.now()}); return; }
      if (m.type === 'presentation-finish') { presentation={active:false,stage:'idle',school:'',position:'',queue:[],current:null,video:null,startedAt:0}; await savePresentation(); broadcast({type:'presentation',presentation,serverNow:Date.now()}); return; }
      throw new Error('Unknown command');
    } catch(e) { send(ws,{type:'error',message:e.message}); }
  });
});
load().then(()=>server.listen(PORT,()=>console.log(`CDS Sports Meet listening on ${PORT}`))).catch(err=>{console.error(err);process.exit(1);});
