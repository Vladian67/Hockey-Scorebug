// Hockey scorebug server — standalone, zero dependencies.  Run:  node server.js
// OBS browser source (1920x1080): http://localhost:3100/bug      Control panel: http://localhost:3100/control
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = Number(process.env.PORT) || 3100, HOST = process.env.HOST || '0.0.0.0';
const DIR = __dirname, STATE_FILE = path.join(DIR, 'hockey-state.json');

const team = o => Object.assign({ name: '', abbr: '', color: '#444444', color2: '#ffffff', logo: '', score: 0, sog: 0 }, o);
const DEFAULT = {
  visible: true,
  away: team({ name: 'TORONTO MAPLE LEAFS', abbr: 'TOR', color: '#00205B', color2: '#FFFFFF' }),
  home: team({ name: 'BOSTON BRUINS', abbr: 'BOS', color: '#000000', color2: '#FFB81C' }),
  period: '1ST',
  clock: { ms: 1200000, running: false, at: 0 },
  penalties: [],            // { id, team, player, minutes, end }  end = game-clock seconds at which it expires
  nextId: 1,
  theme: { accent: '#d70e0f' },
  popdown: { visible: false, team: '', title: '', lines: ['', '', ''] },
  lower: { visible: false, team: 'away', title: '', stats: [{ l: '', v: '' }, { l: '', v: '' }, { l: '', v: '' }] },
  settings: { showSog: true, tenths: true, goalAnim: true, cancelMinor: true, stopOnGoal: true, periodMin: 20, otMin: 5, intMin: 18 },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(t, s) { for (const k of Object.keys(s)) { if (isObj(s[k]) && isObj(t[k])) merge(t[k], s[k]); else t[k] = s[k]; } return t; }
let state = merge(JSON.parse(JSON.stringify(DEFAULT)), (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })());
if (state.theme && /^#e11d2e$/i.test(state.theme.accent)) state.theme.accent = '#d70e0f';
state.clock.running = false; // never resume a running clock after a restart

let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1), () => {}), 300); };
const clients = new Set();
const send = obj => { const d = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const r of clients) r.write(d); };
const curMs = () => state.clock.running ? Math.max(0, state.clock.ms - (Date.now() - state.clock.at)) : state.clock.ms;
let stopT = null;
function setClock(ms, running) {
  const c = state.clock; c.ms = Math.max(0, Math.round(ms)); c.running = !!running && c.ms > 0; c.at = Date.now();
  clearTimeout(stopT);
  if (c.running) stopT = setTimeout(() => { c.ms = 0; c.running = false; c.at = Date.now(); push(); }, c.ms + 20);
}
function prune() { const s = curMs() / 1000; state.penalties = state.penalties.filter(p => s - p.end > 0); }
function push() { prune(); save(); send({ type: 'state', state, now: Date.now() }); }
const other = t => t === 'home' ? 'away' : 'home';
const active = t => { const s = curMs() / 1000; return state.penalties.filter(p => p.team === t && s - p.end > 0); };
const periodLen = p => (/INT/.test(p) ? state.settings.intMin : /OT|SO/.test(p) ? state.settings.otMin : state.settings.periodMin) * 60000;

function readBody(req) { return new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 12e6) { rej(); req.destroy(); } }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); }); }
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

const API = {
  '/api/state': b => { merge(state, b); },
  '/api/score': b => { const t = state[b.team]; if (t) t.score = Math.max(0, t.score + (Number(b.delta) || 0)); },
  '/api/sog': b => { const t = state[b.team]; if (t) t.sog = Math.max(0, t.sog + (Number(b.delta) || 0)); },
  '/api/goal': b => {
    const t = state[b.team]; if (!t) return;
    t.score++;
    if (state.settings.cancelMinor && active(other(b.team)).length > active(b.team).length) {
      const m = active(other(b.team)).filter(p => p.minutes === 2).sort((a, c) => a.end - c.end)[0];
      if (m) state.penalties = state.penalties.filter(p => p.id !== m.id);
    }
    if (state.settings.stopOnGoal) setClock(curMs(), false);
    send({ type: 'event', kind: 'goal', team: b.team, scorer: String(b.scorer || ''), assists: String(b.assists || ''), score: { away: state.away.score, home: state.home.score } });
  },
  '/api/clock': b => {
    const ms = curMs();
    if (b.action === 'start') setClock(ms, true);
    else if (b.action === 'stop') setClock(ms, false);
    else if (b.action === 'toggle') setClock(ms, !state.clock.running);
    else if (b.action === 'set') setClock(Number(b.ms) || 0, state.clock.running);
    else if (b.action === 'adjust') setClock(ms + (Number(b.delta) || 0), state.clock.running);
  },
  '/api/period': b => {
    const v = String(b.value || '').toUpperCase(); if (!v) return;
    const newMs = /FINAL/.test(v) ? 0 : periodLen(v), shift = newMs / 1000 - curMs() / 1000;
    state.penalties.forEach(p => { p.end += shift; });
    state.period = v; setClock(newMs, false);
  },
  '/api/nextperiod': () => {
    const order = ['1ST', '2ND', '3RD', 'OT', '2OT', '3OT', '4OT'], i = order.indexOf(String(state.period).replace(/ INT$/, ''));
    const v = i < 0 ? '1ST' : order[Math.min(i + 1, order.length - 1)];
    API['/api/period']({ value: v });
  },
  '/api/popdown': b => { const p = state.popdown; p.visible = b.action === 'toggle' ? !p.visible : b.action === 'show' ? true : b.action === 'hide' ? false : p.visible; },
  '/api/lower': b => { const p = state.lower; p.visible = b.action === 'toggle' ? !p.visible : b.action === 'show' ? true : b.action === 'hide' ? false : p.visible; },
  '/api/penalty': b => {
    if (b.action === 'add' && state[b.team]) {
      const mins = Number(b.minutes) || 2;
      state.penalties.push({ id: state.nextId++, team: b.team, player: String(b.player || ''), minutes: mins, end: curMs() / 1000 - mins * 60 });
    } else if (b.action === 'remove') state.penalties = state.penalties.filter(p => p.id !== b.id);
    else if (b.action === 'clear') state.penalties = [];
  },
};

const PAGES = { '/bug': 'bug.html', '/control': 'control.html', '/': 'control.html' };
http.createServer(async (req, res) => {
  let url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ type: 'state', state, now: Date.now() }) + '\n\n');
    clients.add(res); const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); }); return;
  }
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, { state, now: Date.now() });
  /* GET bridge for Stream Deck / Stream Dock buttons: /do/<endpoint>?key=value&...  ->  POST /api/<endpoint> with those values */
  let doBody = null;
  if (req.method === 'GET' && url.startsWith('/do/')) {
    const q = new URL(req.url, 'http://x').searchParams; doBody = {};
    for (const [k, v] of q) { const parts = k.split('.'); let o = doBody; parts.slice(0, -1).forEach(p => o = o[p] = o[p] || {}); o[parts[parts.length - 1]] = v === 'true' ? true : v === 'false' ? false : v !== '' && !isNaN(v) && !['distance','down','quarter','spot','value','scorer','assists','player','flagText','period'].includes(parts[parts.length - 1]) ? Number(v) : v; }
    if (url === '/do/state') { const tg = (o, cur) => { for (const k of Object.keys(o)) { if (o[k] === 'toggle') o[k] = !(cur && cur[k]); else if (o[k] && typeof o[k] === 'object') tg(o[k], cur && cur[k]); } }; tg(doBody, state); }
    url = '/api/' + url.slice(4); req.method = 'POST';
  }
  if (req.method === 'POST' && API[url]) { API[url](doBody || await readBody(req)); push(); return json(res, 200, { ok: true }); }
  const page = PAGES[url] || (/^\/[\w.-]+\.html$/.test(url) ? url.slice(1) : null);
  if (page) {
    fs.readFile(path.join(DIR, page), (e, d) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Missing ' + page); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d);
    }); return;
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, HOST, () => {
  console.log('\n  Hockey scorebug running');
  console.log(`  OBS Browser Source (1920x1080):  http://localhost:${PORT}/bug`);
  console.log(`  Control panel:                   http://localhost:${PORT}/control\n`);
});
