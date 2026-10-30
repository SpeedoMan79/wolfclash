const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Redis } = require('@upstash/redis');
let webpush = null;
try { webpush = require('web-push'); } catch { console.warn('!!! web-push package missing: push notifications disabled (run npm install) !!!'); }

// ====== ENV (Render me set karo) ======
// UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// JWT_SECRET, ADMIN_USER, ADMIN_PASS
// ZAPUPI_KEY (your zap_key), BASE_URL (e.g. https://yourapp.onrender.com, no trailing slash)
// ZAPUPI_WEBHOOK_TOKEN (random secret appended to the webhook URL as ?t=...)
// ZAPUPI_API (optional, default https://pay.zapupi.com/api), ALLOW_ZAPUPI_TEST=1 (only to accept test-mode payments in production)
const crypto = require('crypto');
const IS_PROD = !!process.env.RENDER || process.env.NODE_ENV === 'production';
const {
  ADMIN_USER = 'admin', ADMIN_PASS = '', ZAPUPI_KEY, ZAPUPI_WEBHOOK_TOKEN = '', BASE_URL = '',
  ZAPUPI_API = 'https://pay.zapupi.com/api', ALLOW_ZAPUPI_TEST, PORT = 3000, ALLOW_MEMORY_DB, ALLOW_REDIS_IMAGES,
  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
} = process.env;
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'change-me') {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('!!! JWT_SECRET not set: using a random one (everyone is logged out on each restart). Set it in Render. !!!');
}
const ADMIN_ENABLED = ADMIN_PASS.length >= 8 && ADMIN_PASS !== 'admin123';
if (!ADMIN_ENABLED) console.warn('!!! ADMIN_PASS missing/weak (min 8 chars, not admin123): admin login is DISABLED !!!');

const SITE = BASE_URL.replace(/\/+$/, '');
if (!ZAPUPI_KEY) console.warn('!!! ZAPUPI_KEY missing: deposits are DISABLED !!!');
else if (!ZAPUPI_WEBHOOK_TOKEN) console.warn('!!! ZAPUPI_WEBHOOK_TOKEN not set: webhook URL has no secret. Payments are still verified server-to-server, but set a token anyway. !!!');

const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : (() => {
    if (IS_PROD && ALLOW_MEMORY_DB !== '1') { console.error('UPSTASH_REDIS_REST_URL missing in production. Refusing to start with a volatile in-memory DB (set ALLOW_MEMORY_DB=1 to override).'); process.exit(1); }
    console.warn('!!! UPSTASH env missing: in-memory store (data lost on restart) !!!');
    const mem = new Map();
    return { get: async k => mem.get(k) ?? null, set: async (k, x) => { mem.set(k, x); }, rpush: async () => {} };
  })();

const DEFAULT = () => ({
  users: {}, games: [
    { id: 'g1', name: 'BR SURVIVAL', image: '' },
    { id: 'g2', name: 'PER KILL MATCHES', image: '' },
    { id: 'g3', name: 'LONE WOLF 2v2', image: '' }
  ],
  matches: [], joins: [], deposits: [], withdrawals: [], txns: [], notices: [], promos: [], tickets: [], logs: [],
  adminPush: [], adminAlerts: [],
  settings: {
    appName: 'Arena Battle', logo: '', announcement: 'Welcome! Fair play karo.',
    signupBonus: 0, referrerBonus: 0, referralMinEntry: 0,
    minDeposit: 10, maxDeposit: 1000, minWithdraw: 50,
    depositBonus: [{ dep: 50, bonus: 10 }, { dep: 100, bonus: 20 }, { dep: 200, bonus: 40 }, { dep: 300, bonus: 50 }, { dep: 500, bonus: 100 }],
    maintenance: false, maintenanceMsg: 'Under maintenance. Thodi der baad aao.', banners: [], images: {}, dailyReward: 1, withdrawFee: 0, maxWithdrawPerDay: 1, rules: '1. Hacks/teaming not allowed.\n2. Room ID match se pehle milega.\n3. Admin ka decision final.', telegram: '', whatsapp: '', about: 'About us', faq: 'FAQ', terms: 'Terms & Conditions', privacy: 'Privacy Policy', contact: 'support@example.com'
  }
});

let db = null;
let chain = Promise.resolve();
const lock = fn => (chain = chain.then(fn, fn));
async function load() {
  db = (await redis.get('arenadb')) || DEFAULT();
  if (typeof db === 'string') db = JSON.parse(db);
  const d = DEFAULT();
  Object.keys(d).forEach(k => { if (db[k] === undefined) db[k] = d[k]; });
  Object.keys(d.settings).forEach(k => { if (db.settings[k] === undefined) db.settings[k] = d.settings[k]; });
  migrate();
}
const archive = []; // ledger rows trimmed from the live list are appended to Redis list "ledger:archive" (never discarded)
async function save() {
  try {
    await redis.set('arenadb', JSON.stringify(db));
    if (archive.length) { const rows = archive.splice(0).map(r => JSON.stringify(r)); try { await redis.rpush('ledger:archive', ...rows); } catch (e) { archive.push(...rows.map(r => JSON.parse(r))); } }
  } catch (e) {
    console.error('Redis save failed:', e.message);
    try { await load(); } catch { /* keep going; error below tells the client */ }
    const err = new Error('Could not save to database. Nothing was changed, please retry.'); err.status = 503; throw err;
  }
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const num = (v, d = 0) => (isFinite(+v) ? +v : d);
const SZ = { Solo: 1, Duo: 2, Squad: 4 };
const sizeOf = m => SZ[m.type] || 1;
function migrate() { // purane joins ko slot assign
  db.matches.forEach(m => {
    const sz = sizeOf(m), js = db.joins.filter(j => j.matchId === m.id), used = new Set(js.filter(j => j.slot).map(j => j.slot + '-' + j.pos));
    js.filter(j => !j.slot).forEach(j => { for (let s = 1; s <= m.slots && !j.slot; s++) for (let p = 0; p < sz && !j.slot; p++) if (!used.has(s + '-' + p)) { j.slot = s; j.pos = p; used.add(s + '-' + p); } if (!j.slot) { j.slot = m.slots + 1; j.pos = 0; } });
  });
}
const notify = (to, title, body, image) => { db.notices.unshift({ id: uid(), title, body, image: image || '', to, at: Date.now() }); db.notices = db.notices.slice(0, 500); return queuePush(to, title, body, image); };

// ====== WEB PUSH (phone / browser notifications) ======
// VAPID keys are generated once and kept in Redis ("vapid"), so no extra env setup is needed.
let pushReady = false, vapidPublic = '';
async function initPush() {
  if (!webpush) return;
  try {
    let v = await redis.get('vapid');
    if (typeof v === 'string') v = JSON.parse(v);
    if (!v || !v.publicKey || !v.privateKey) { v = webpush.generateVAPIDKeys(); await redis.set('vapid', JSON.stringify(v)); console.log('Generated new VAPID keys'); }
    const subject = process.env.VAPID_SUBJECT || (SITE.startsWith('https://') ? SITE : 'mailto:admin@example.com');
    webpush.setVapidDetails(subject, v.publicKey, v.privateKey);
    vapidPublic = v.publicKey; pushReady = true;
  } catch (e) { console.error('Push init failed:', e.message); }
}
function pushTargets(to) { // to = array of user ids, or null/undefined = everyone
  const ids = Array.isArray(to) ? to : Object.keys(db.users), out = [];
  for (const id of ids) { const u = db.users[id]; if (u && !u.banned && u.push) for (const s of u.push) out.push({ uid: u.id, sub: s }); }
  return out;
}
async function sendAll(targets, payload) {
  const dead = [];
  for (let i = 0; i < targets.length; i += 20) {
    await Promise.all(targets.slice(i, i + 20).map(async t => {
      try { await webpush.sendNotification(t.sub, payload, { TTL: 86400 }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(t); else console.warn('push failed', e.statusCode || e.message); }
    }));
  }
  if (dead.length) lock(async () => { // device uninstalled / permission revoked: forget it
    dead.forEach(t => {
      if (t.uid === '__admin') { db.adminPush = (db.adminPush || []).filter(p => p.endpoint !== t.sub.endpoint); return; }
      const u = db.users[t.uid]; if (u && u.push) u.push = u.push.filter(p => p.endpoint !== t.sub.endpoint);
    });
    await save().catch(() => {});
  });
}
function queuePush(to, title, body, image) {
  if (!pushReady || !db) return 0;
  const targets = pushTargets(to); if (!targets.length) return 0;
  const logo = db.settings.logo || '', img = String(image || '');
  const payload = JSON.stringify({ title: String(title || db.settings.appName).slice(0, 80), body: String(body || '').slice(0, 220), url: '/', icon: /^https:\/\//.test(logo) ? logo : '', image: /^https:\/\//.test(img) ? img : '' });
  setImmediate(() => sendAll(targets, payload).catch(e => console.error('push error', e.message)));
  return targets.length;
}

const fT = t => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
// Admin ko alert: panel me list (db.adminAlerts) + registered admin devices par push
function adminNotify(title, body) {
  db.adminAlerts = db.adminAlerts || [];
  db.adminAlerts.unshift({ id: uid(), title, body, at: Date.now() });
  db.adminAlerts = db.adminAlerts.slice(0, 100);
  if (!pushReady) return 0;
  const targets = (db.adminPush || []).map(s => ({ uid: '__admin', sub: s }));
  if (!targets.length) return 0;
  const payload = JSON.stringify({ title: String(title).slice(0, 80), body: String(body).slice(0, 220), url: '/admin', icon: '', image: '' });
  setImmediate(() => sendAll(targets, payload).catch(e => console.error('admin push error', e.message)));
  return targets.length;
}

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(cors(BASE_URL ? { origin: BASE_URL } : {}));
const hits = new Map();
const rl = (max, ms) => (req, res, next) => {
  if (req.method !== 'POST') return next();
  const k = req.baseUrl + req.path + '|' + req.ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < ms);
  if (h.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  h.push(now); hits.set(k, h); if (hits.size > 5000) hits.clear(); next();
};
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(['/api/login', '/api/signup', '/api/admin/login'], rl(10, 15 * 60e3));
app.use(['/api/deposit', '/api/withdraw', '/api/promo', '/api/daily', '/api/join', '/api/change-slot', '/api/password', '/api/ticket', '/api/admin/upload', '/api/push/subscribe'], rl(30, 60e3));
app.use('/api', (req, res, next) => {
  if (db && db.settings.maintenance && !req.path.startsWith('/admin') && req.path !== '/settings' && req.path !== '/webhook') return res.status(503).json({ error: db.settings.maintenanceMsg });
  next();
});
const wrap = fn => (req, res) =>
  lock(async () => {
    try { await fn(req, res); }
    catch (e) { console.error(e); if (!res.headersSent) res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
  });
const fail = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };

function auth(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { return jwt.verify(t, JWT_SECRET); } catch { fail('Login required', 401); }
}
const user = req => { const p = auth(req); const u = db.users[p.id]; if (!u || p.admin) fail('Login required', 401); if (u.banned) fail('Account banned', 403); return u; };
const admin = req => { const p = auth(req); if (!p.admin) fail('Admin only', 403); };
const total = u => u.dep + u.win + u.bonus;
const pub = u => ({ id: u.id, username: u.username, dep: u.dep, win: u.win, bonus: u.bonus, total: total(u), matches: u.matches, kills: u.kills, earning: u.earning, refCode: u.username });
function tx(u, type, wallet, amt, note) {
  db.txns.unshift({ id: Math.floor(1e6 + Math.random() * 9e6), uid: u.id, type, wallet, amt, bal: u[wallet], note, at: Date.now() });
  archive.push(...db.txns.splice(5000));
}

// ====== AUTH ======
app.post('/api/signup', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ref = String(req.body.ref || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) fail('Username 3-20 chars (a-z, 0-9, _)');
  if (password.length < 6) fail('Password min 6 chars');
  if (Object.values(db.users).some(u => u.username === username)) fail('Username already taken');
  const u = { id: uid(), username, hash: bcrypt.hashSync(password, 8), dep: 0, win: 0, bonus: 0, matches: 0, kills: 0, earning: 0, createdAt: Date.now(), referredBy: null, refPaid: false };
  if (ref) { const r = Object.values(db.users).find(x => x.username === ref); if (r && r.id !== u.id) u.referredBy = r.id; }
  const sb = num(db.settings.signupBonus);
  if (sb > 0 && u.referredBy) { u.bonus += sb; tx(u, 'credit', 'bonus', sb, 'Register bonus'); }
  db.users[u.id] = u;
  await save();
  res.json({ token: jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '60d' }), user: pub(u) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const u = Object.values(db.users).find(x => x.username === username);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) fail('Wrong username or password', 401);
  if (u.banned) fail('Account banned', 403);
  res.json({ token: jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '60d' }), user: pub(u) });
}));

app.get('/api/me', wrap(async (req, res) => res.json(pub(user(req)))));

// ====== PUBLIC / HOME ======
app.get('/api/settings', wrap(async (req, res) => {
  const s = db.settings;
  res.json({ maintenance: s.maintenance, maintenanceMsg: s.maintenanceMsg, banners: s.banners, images: s.images || {}, dailyReward: s.dailyReward, withdrawFee: s.withdrawFee, rules: s.rules, telegram: s.telegram, whatsapp: s.whatsapp, appName: s.appName, logo: s.logo, announcement: s.announcement, depositBonus: s.depositBonus, minDeposit: s.minDeposit, maxDeposit: s.maxDeposit, minWithdraw: s.minWithdraw, referrerBonus: s.referrerBonus, signupBonus: s.signupBonus, referralMinEntry: s.referralMinEntry, about: s.about, faq: s.faq, terms: s.terms, privacy: s.privacy, contact: s.contact });
}));

app.get('/api/games', wrap(async (req, res) => {
  res.json(db.games.map(g => ({ ...g, count: db.matches.filter(m => m.gameId === g.id && m.status === 'upcoming').length })));
}));

const roomOpen = m => m.status === 'ongoing' || !m.roomShowMins || Date.now() >= m.time - m.roomShowMins * 6e4;
const matchView = (m, u) => {
  const joined = db.joins.filter(j => j.matchId === m.id), sz = sizeOf(m);
  const mine = u && joined.find(j => j.uid === u.id);
  return { id: m.id, gameId: m.gameId, title: m.title, image: m.image, time: m.time, prize: m.prize, perKill: m.perKill, fee: m.fee, type: m.type, map: m.map, slots: m.slots, size: sz, capacity: m.slots * sz, filled: joined.length, status: m.status, joined: !!mine, mine: mine ? { slot: mine.slot, pos: mine.pos } : null, seats: joined.map(j => ({ slot: j.slot, pos: j.pos, ign: j.ign, me: !!(u && j.uid === u.id) })), rankPrizes: m.rankPrizes || [], splitPrize: !!m.splitPrize, room: mine && m.status === 'upcoming' || mine && m.status === 'ongoing' ? (roomOpen(m) ? { id: m.roomId, pass: m.roomPass } : { hidden: true, showAt: m.time - m.roomShowMins * 6e4 }) : null, result: m.status === 'resulted' ? m.result : null };
};
app.get('/api/matches', wrap(async (req, res) => {
  const u = (() => { try { return user(req); } catch { return null; } })();
  const { game, status = 'upcoming' } = req.query;
  let list = db.matches.filter(m => (!game || m.gameId === game) && m.status === status);
  list.sort((a, b) => status === 'resulted' ? b.time - a.time : a.time - b.time);
  res.json(list.slice(0, 100).map(m => matchView(m, u)));
}));

app.post('/api/join', wrap(async (req, res) => {
  const u = user(req);
  const m = db.matches.find(x => x.id === req.body.matchId);
  const ign = String(req.body.ign || '').trim();
  if (!m || m.status !== 'upcoming') fail('Match not available');
  if (!ign) fail('In-game name required');
  if (m.regDeadline && Date.now() > m.regDeadline) fail('Registration is closed');
  const joined = db.joins.filter(j => j.matchId === m.id);
  if (joined.some(j => j.uid === u.id)) fail('Already joined');
  const sz = sizeOf(m), slot = Math.floor(num(req.body.slot)), pos = Math.floor(num(req.body.pos));
  if (joined.length >= m.slots * sz) fail('Joining full');
  if (slot < 1 || slot > m.slots || pos < 0 || pos >= sz) fail('Pehle slot choose karo');
  if (joined.some(j => j.slot === slot && j.pos === pos)) fail('Ye slot abhi kisi ne le liya, dusra chuno');
  const fee = num(m.fee);
  if (total(u) < fee) fail('Insufficient balance. Recharge karo.');
  let rem = fee;
  for (const w of ['dep', 'bonus', 'win']) { const t = Math.min(u[w], rem); if (t > 0) { u[w] -= t; rem -= t; tx(u, 'debit', w, t, 'Joined ' + m.title); } }
  db.joins.push({ id: uid(), matchId: m.id, uid: u.id, ign, slot, pos, at: Date.now() });
  if (!u.ign) u.ign = ign;
  u.matches++;
  if (joined.length + 1 >= m.slots * sz && !m.fullNotified) { // match full: admin ko alert
    m.fullNotified = true;
    adminNotify('Match FULL ✅: ' + m.title, `${m.title} (${fT(m.time)}) full ho gaya (${m.slots * sz}/${m.slots * sz}). Room ID/password dene ke liye ready raho.`);
    log('Match full: ' + m.title);
  }
  // referral reward on first paid match
  if (fee > 0 && fee >= num(db.settings.referralMinEntry) && u.referredBy && !u.refPaid) {
    const r = db.users[u.referredBy]; const rb = num(db.settings.referrerBonus);
    u.refPaid = true;
    if (r && rb > 0) { r.bonus += rb; tx(r, 'credit', 'bonus', rb, 'Referral reward: ' + u.username); }
  }
  await save();
  res.json({ ok: true, user: pub(u) });
}));

app.post('/api/change-slot', wrap(async (req, res) => {
  const u = user(req); const m = db.matches.find(x => x.id === req.body.matchId);
  if (!m || m.status !== 'upcoming') fail('Match not available');
  const me = db.joins.find(j => j.matchId === m.id && j.uid === u.id); if (!me) fail('Pehle join karo');
  const sz = sizeOf(m), slot = Math.floor(num(req.body.slot)), pos = Math.floor(num(req.body.pos));
  if (slot < 1 || slot > m.slots || pos < 0 || pos >= sz) fail('Slot choose karo');
  if (db.joins.some(j => j.matchId === m.id && j.slot === slot && j.pos === pos)) fail('Slot already booked');
  me.slot = slot; me.pos = pos; await save(); res.json({ ok: true });
}));
app.get('/api/my-matches', wrap(async (req, res) => {
  const u = user(req);
  const st = req.query.status || 'upcoming';
  const ids = db.joins.filter(j => j.uid === u.id).map(j => j.matchId);
  res.json(db.matches.filter(m => ids.includes(m.id) && m.status === st).map(m => matchView(m, u)));
}));

app.get('/api/leaderboard', wrap(async (req, res) => {
  const range = req.query.range || 'monthly';
  const since = range === 'weekly' ? Date.now() - 7 * 864e5 : range === 'monthly' ? Date.now() - 30 * 864e5 : 0;
  const agg = {};
  db.txns.filter(t => t.type === 'prize' && t.at >= since).forEach(t => { agg[t.uid] = (agg[t.uid] || 0) + t.amt; });
  const rows = Object.entries(agg).map(([id, w]) => ({ name: db.users[id]?.username || '?', win: w })).sort((a, b) => b.win - a.win).slice(0, 50);
  res.json(rows);
}));

app.get('/api/wallet', wrap(async (req, res) => {
  const u = user(req);
  res.json({ ...pub(u), history: db.txns.filter(t => t.uid === u.id).slice(0, 50), deposits: db.deposits.filter(d => d.uid === u.id).slice(-30).reverse(), withdrawals: db.withdrawals.filter(w => w.uid === u.id).slice(-30).reverse() });
}));

app.get('/api/notifications', wrap(async (req, res) => { const u = user(req); res.json(db.notices.filter(n => !n.to || n.to.includes(u.id)).slice(0, 50)); }));

// ====== PUSH SUBSCRIPTIONS ======
app.get('/api/push/key', (req, res) => res.json({ key: pushReady ? vapidPublic : null }));
app.post('/api/push/subscribe', wrap(async (req, res) => {
  const u = user(req), s = req.body && req.body.sub;
  if (!pushReady) fail('Push not available', 400);
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 600 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') fail('Invalid subscription');
  const had = (u.push || []).some(p => p.endpoint === s.endpoint);
  Object.values(db.users).forEach(x => { if (x.push) x.push = x.push.filter(p => p.endpoint !== s.endpoint); }); // a device belongs to ONE account
  u.push = (u.push || []).concat({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) }, at: Date.now() }).slice(-5);
  await save();
  if (!had) webpush.sendNotification(u.push[u.push.length - 1], JSON.stringify({ title: 'Notifications ON 🔔', body: 'Ab match room, result aur wallet updates yahin milenge.', url: '/', icon: '', image: '' })).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', wrap(async (req, res) => {
  const u = user(req), ep = String((req.body && req.body.endpoint) || '');
  if (u.push) { u.push = u.push.filter(p => p.endpoint !== ep); await save(); }
  res.json({ ok: true });
}));
app.get('/manifest.json', (q, r) => { r.type('application/manifest+json'); r.set('Cache-Control', 'no-cache'); r.sendFile(path.join(__dirname, 'manifest.json')); });
app.get(['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'], (q, r) => r.set('Cache-Control', 'public,max-age=86400').sendFile(path.join(__dirname, q.path.slice(1))));
app.get('/.well-known/assetlinks.json', (q, r) => { r.type('application/json'); r.set('Cache-Control', 'no-cache'); r.sendFile(path.join(__dirname, 'assetlinks.json')); });
app.get('/sw.js', (q, r) => { r.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); r.type('application/javascript'); r.sendFile(path.join(__dirname, 'sw.js')); });

// ====== DEPOSIT (ZAPUPI) ======
function bonusFor(amount) {
  const t = db.settings.depositBonus.filter(x => amount >= x.dep).sort((a, b) => b.dep - a.dep)[0];
  return t ? num(t.bonus) : 0;
}
// ZapUPI call (JSON body, zap_key always added server-side, never sent to the browser)
async function zapPost(endpoint, body) {
  let r;
  try {
    r = await fetch(`${ZAPUPI_API}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zap_key: ZAPUPI_KEY, ...body }), signal: AbortSignal.timeout(15000) });
  } catch (e) { fail('Payment gateway unreachable, try again', 502); }
  const j = await r.json().catch(() => null);
  if (!j || typeof j !== 'object') fail('Payment gateway returned an invalid reply', 502);
  return j;
}
app.post('/api/deposit', wrap(async (req, res) => {
  const u = user(req);
  const amount = Math.floor(num(req.body.amount));
  if (amount < db.settings.minDeposit || amount > db.settings.maxDeposit) fail(`Amount ${db.settings.minDeposit}-${db.settings.maxDeposit}`);
  if (!ZAPUPI_KEY) fail('Payment gateway not configured', 503);
  const orderId = 'ORD' + Date.now() + crypto.randomBytes(3).toString('hex'); // unique per payment
  // Save the pending order FIRST, so a webhook can never arrive for an order we don't know about
  const d = { id: orderId, uid: u.id, amount, status: 'pending', at: Date.now() };
  db.deposits.push(d);
  await save();
  const payload = { order_id: orderId, amount: String(amount), remark: u.id };
  if (SITE) {
    payload.success_url = payload.failed_url = payload.timeout_url = SITE + '/';
    if (ZAPUPI_WEBHOOK_TOKEN) payload.webhook_url = `${SITE}/api/webhook?t=${encodeURIComponent(ZAPUPI_WEBHOOK_TOKEN)}`;
  }
  let j;
  try { j = await zapPost('create-order', payload); }
  catch (e) { d.status = 'failed'; await save().catch(() => {}); throw e; }
  const url = String(j.payment_url || (j.data && j.data.payment_url) || '');
  if (String(j.status).toLowerCase() !== 'success' || !/^https:\/\//i.test(url)) {
    console.error('ZapUPI create-order rejected:', JSON.stringify(j).slice(0, 300));
    d.status = 'failed'; await save();
    fail('Gateway error: ' + String(j.message || 'try again').slice(0, 100), 502);
  }
  res.json({ orderId, url });
}));

// Confirms the payment with ZapUPI (never trusts the webhook body), then credits the wallet exactly once.
// Runs inside the global lock (wrap / lock), so two concurrent calls can't double-credit.
async function settleDeposit(d) {
  if (!ZAPUPI_KEY || !['pending', 'failed'].includes(d.status)) return d; // approved / under review = final
  const j = await zapPost('order-status', { order_id: d.id });
  const o = j.data;
  if (!o || typeof o !== 'object') return d; // unknown order / gateway error: leave as is
  if (o.order_id !== undefined && String(o.order_id) !== d.id) return d;
  const st = String(o.status || '').toLowerCase();
  if (st === 'success') {
    const txn = String(o.txn_id || '').slice(0, 100), env = String(o.environment || '').toLowerCase();
    if ((env === 'test' || /^DUMMY/i.test(txn)) && IS_PROD && ALLOW_ZAPUPI_TEST !== '1') { console.warn('Ignoring TEST-mode payment for', d.id); return d; }
    const gAmt = Number(o.amount), gPaid = o.pay_amount === undefined ? gAmt : Number(o.pay_amount);
    const u = db.users[d.uid];
    const dupTxn = txn && db.deposits.some(x => x !== d && x.status === 'approved' && x.txnId === txn);
    if (!u || !isFinite(gAmt) || !isFinite(gPaid) || Math.abs(gAmt - d.amount) > 0.001 || gPaid + 0.001 < d.amount || dupTxn) {
      d.status = 'review'; d.note = `Gateway said ${o.amount}/${o.pay_amount}, expected ${d.amount}${dupTxn ? ' (duplicate txn)' : ''}`;
      console.error('Deposit needs manual review:', d.id, d.note); log('Deposit flagged for review ' + d.id);
      await save(); return d;
    }
    u.dep += d.amount; tx(u, 'credit', 'dep', d.amount, 'Deposit of orderId: ' + d.id);
    const b = bonusFor(d.amount);
    if (b > 0) { u.bonus += b; tx(u, 'credit', 'bonus', b, 'Deposit bonus'); }
    d.status = 'approved'; d.txnId = txn; d.utr = String(o.utr || '').slice(0, 40); d.paidAt = Date.now();
    notify([u.id], 'Deposit successful ✅', `₹${d.amount} added to your wallet` + (b > 0 ? ` + ₹${b} bonus` : ''));
    await save();
  } else if (st === 'failed' && d.status === 'pending') { d.status = 'failed'; await save(); }
  return d;
}
app.get('/api/deposit/check/:id', wrap(async (req, res) => {
  const u = user(req);
  const d = db.deposits.find(x => x.id === req.params.id && x.uid === u.id);
  if (!d) fail('Not found', 404);
  await settleDeposit(d);
  res.json({ status: d.status, user: pub(u) });
}));

// ZapUPI webhook. The body is only used to learn WHICH order changed; the real status/amount come from the
// server-to-server order-status call above. ?t=<ZAPUPI_WEBHOOK_TOKEN> keeps random callers out.
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
app.post('/api/webhook', (req, res) => {
  if (ZAPUPI_WEBHOOK_TOKEN && !safeEq(req.query.t || '', ZAPUPI_WEBHOOK_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
  const id = String((req.body && req.body.order_id) || '').trim().slice(0, 60);
  if (!id) return res.json({ status: 'ok' });
  lock(async () => {
    try {
      const d = db.deposits.find(x => x.id === id);
      if (d) await settleDeposit(d);
      res.json({ status: 'ok' }); // unknown orders also get 200 so ZapUPI stops retrying
    } catch (e) {
      console.error('Webhook failed for', id, e.message);
      if (!res.headersSent) res.status(503).json({ status: 'retry' }); // transient (gateway/DB down): ask ZapUPI to retry
    }
  });
});

// ====== WITHDRAW ======
app.post('/api/withdraw', wrap(async (req, res) => {
  const u = user(req);
  const amount = Math.floor(num(req.body.amount));
  const method = String(req.body.method || 'UPI').slice(0, 20);
  const upi = String(req.body.upi || '').trim().slice(0, 60);
  if (!/^[\w.\-]{2,}@[\w]{2,}$/.test(upi)) fail('Valid UPI ID daalo');
  if (amount < db.settings.minWithdraw) fail('Minimum withdraw ₹' + db.settings.minWithdraw);
  if (amount > u.win) fail('Win balance kam hai');
  if (db.withdrawals.some(w => w.uid === u.id && w.status === 'pending')) fail('Ek request pending hai');
  const today = new Date().toDateString();
  if (db.withdrawals.filter(w => w.uid === u.id && new Date(w.at).toDateString() === today && w.status !== 'rejected').length >= num(db.settings.maxWithdrawPerDay, 1)) fail('Daily withdraw limit reached');
  const fee = Math.round(amount * num(db.settings.withdrawFee)) / 100;
  u.win -= amount; tx(u, 'debit', 'win', amount, 'Withdraw request');
  db.withdrawals.push({ id: Math.floor(1e4 + Math.random() * 9e4), uid: u.id, username: u.username, method, upi, amount, fee, payout: amount - fee, status: 'pending', at: Date.now() });
  await save();
  res.json({ ok: true, user: pub(u) });
}));

// ====== ADMIN ======
app.post('/api/admin/login', wrap(async (req, res) => {
  if (!ADMIN_ENABLED) fail('Admin login disabled: set a strong ADMIN_PASS in Render', 503);
  const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
  if (!(eq(req.body.username, ADMIN_USER) & eq(req.body.password, ADMIN_PASS))) fail('Wrong admin login', 401);
  res.json({ token: jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' }) });
}));
app.get('/api/admin/stats', wrap(async (req, res) => {
  admin(req);
  res.json({ dbKB: Math.round(JSON.stringify(db).length / 1024), banned: Object.values(db.users).filter(u => u.banned).length, liabilities: Object.values(db.users).reduce((a, u) => a + u.win + u.dep + u.bonus, 0), pendingDeposits: db.deposits.filter(d => d.status === 'pending').length, pushUsers: Object.values(db.users).filter(u => u.push && u.push.length).length, openTickets: db.tickets.filter(t => t.status === 'open').length, users: Object.keys(db.users).length, matches: db.matches.length, pendingWithdraw: db.withdrawals.filter(w => w.status === 'pending').length, depositTotal: db.deposits.filter(d => d.status === 'approved').reduce((a, d) => a + d.amount, 0), withdrawTotal: db.withdrawals.filter(w => w.status === 'approved').reduce((a, d) => a + d.amount, 0) });
}));
app.get('/api/admin/users', wrap(async (req, res) => { admin(req); res.json(Object.values(db.users).map(u => ({ ...pub(u), banned: !!u.banned, createdAt: u.createdAt }))); }));
app.post('/api/admin/user/:id', wrap(async (req, res) => {
  admin(req);
  const u = db.users[req.params.id]; if (!u) fail('No user', 404);
  const { action, wallet = 'dep', amount = 0 } = req.body;
  log('User ' + action + ' ' + u.username);
  if (action === 'ban') u.banned = true;
  else if (action === 'unban') u.banned = false;
  else if ((action === 'add' || action === 'deduct') && ['dep', 'win', 'bonus'].includes(wallet)) {
    const a = num(amount), reason = String(req.body.reason || '').trim().slice(0, 120);
    if (a <= 0) fail('Amount must be positive'); if (reason.length < 3) fail('Reason is required for balance adjustments');
    const d = action === 'add' ? a : Math.min(a, u[wallet]);
    u[wallet] += action === 'add' ? d : -d;
    tx(u, action === 'add' ? 'credit' : 'debit', wallet, d, 'Admin adjustment by ' + ADMIN_USER + ': ' + reason);
    log('Adjust ' + action + ' ' + d + ' ' + wallet + ' ' + u.username + ' (' + reason + ')');
  } else fail('Unknown action');
  await save(); res.json({ ok: true });
}));
app.get('/api/admin/games', wrap(async (req, res) => { admin(req); res.json(db.games); }));
app.post('/api/admin/game', wrap(async (req, res) => {
  admin(req);
  const { id, name, image } = req.body;
  if (id) { const g = db.games.find(x => x.id === id); if (g) { g.name = name; g.image = image || ''; } }
  else db.games.push({ id: uid(), name, image: image || '' });
  await save(); res.json({ ok: true });
}));
app.delete('/api/admin/game/:id', wrap(async (req, res) => { admin(req); db.games = db.games.filter(g => g.id !== req.params.id); await save(); res.json({ ok: true }); }));
app.get('/api/admin/matches', wrap(async (req, res) => {
  admin(req);
  res.json(db.matches.slice().reverse().map(m => ({ ...m, size: sizeOf(m), players: db.joins.filter(j => j.matchId === m.id).map(j => ({ uid: j.uid, ign: j.ign, slot: j.slot, pos: j.pos, username: db.users[j.uid]?.username })) })));
}));
app.post('/api/admin/match', wrap(async (req, res) => {
  admin(req);
  const b = req.body;
  const data = { gameId: b.gameId, title: String(b.title || ''), image: b.image || '', time: new Date(b.time).getTime() || Date.now(), prize: num(b.prize), perKill: num(b.perKill), fee: num(b.fee), type: b.type || 'Solo', map: b.map || '', slots: Math.max(1, Math.floor(num(b.slots, 20))),
    ...(b.regDeadline !== undefined ? { regDeadline: b.regDeadline ? new Date(b.regDeadline).getTime() || 0 : 0 } : {}),
    ...(b.roomShowMins !== undefined ? { roomShowMins: Math.max(0, Math.floor(num(b.roomShowMins))) } : {}), roomId: b.roomId || '', roomPass: b.roomPass || '', rankPrizes: (Array.isArray(b.rankPrizes) ? b.rankPrizes : []).map(x => num(x)).filter(x => x > 0).slice(0, 50), splitPrize: !!b.splitPrize };
  if (b.id) { const m = db.matches.find(x => x.id === b.id); if (!m) fail('No match', 404);
    const nsz = SZ[data.type] || 1;
    if (db.joins.some(j => j.matchId === m.id && (j.slot > data.slots || j.pos >= nsz))) fail('Kuch players ke slots nayi setting se bahar hain — pehle unhe Move/Kick karo');
    Object.assign(m, data); m.fullNotified = false; }
  else db.matches.push({ id: uid(), status: 'upcoming', ...data });
  await save(); res.json({ ok: true });
}));
app.post('/api/admin/match/:id/status', wrap(async (req, res) => {
  admin(req);
  const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('No match', 404);
  if (['upcoming', 'ongoing'].includes(req.body.status)) m.status = req.body.status;
  await save(); res.json({ ok: true });
}));
// Cancel + har joined user ko exact entry fee wapas (caller save() karega)
function cancelAndRefund(m, msg) {
  const fee = num(m.fee), js = db.joins.filter(j => j.matchId === m.id);
  js.forEach(j => { const u = db.users[j.uid]; if (u) { if (fee > 0) { u.dep += fee; tx(u, 'credit', 'dep', fee, 'Refund: ' + m.title); } u.matches = Math.max(0, u.matches - 1); } });
  notify(js.map(j => j.uid), 'Match cancelled: ' + m.title, msg || 'Entry fee has been refunded.');
  db.joins = db.joins.filter(j => j.matchId !== m.id);
  m.status = 'cancelled'; m.cancelledAt = Date.now();
  return js.length;
}
app.post('/api/admin/match/:id/cancel', wrap(async (req, res) => {
  admin(req);
  const m = db.matches.find(x => x.id === req.params.id); if (!m || m.status === 'resulted' || m.status === 'cancelled') fail('Cannot cancel');
  cancelAndRefund(m); log('Match cancelled+refunded: ' + m.title);
  await save(); res.json({ ok: true });
}));

// Auto: match time par full nahi hai -> cancel + refund + agli date, same time par same details ka naya match
const DAY = 864e5;
function autoProcessMatches() {
  const now = Date.now(); let changed = 0;
  for (const m of db.matches.slice()) {
    if (m.status !== 'upcoming' || !m.time || m.time > now) continue;
    if (db.joins.filter(j => j.matchId === m.id).length >= m.slots * sizeOf(m)) continue; // full: admin sambhalega
    const n = cancelAndRefund(m, 'Match full nahi hua, isliye cancel ho gaya. Entry fee refund ho gayi. Naya match agli date par same time par laga diya gaya hai.');
    let t = m.time + DAY; while (t <= now) t += DAY; // agli date, same time (always future me)
    const { id, status, cancelledAt, result, fullNotified, rescheduledTo, autoCancelled, ...rest } = m;
    const nm = { ...rest, id: uid(), status: 'upcoming', time: t };
    if (m.regDeadline) nm.regDeadline = m.regDeadline + (t - m.time);
    db.matches.push(nm);
    m.autoCancelled = true; m.rescheduledTo = nm.id;
    log(`Auto-cancel (not full) + refund ${n} player(s): ${m.title} -> new match ${fT(t)}`);
    changed++;
  }
  return changed;
}
function runAutoMatches() {
  if (!db) return;
  lock(async () => {
    try { if (autoProcessMatches()) await save(); }
    catch (e) { console.error('auto match job failed:', e.message); }
  });
}
// results: [{uid, kills, prize}]
app.post('/api/admin/match/:id/result', wrap(async (req, res) => {
  admin(req);
  const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('No match', 404);
  if (m.status === 'resulted') fail('Already resulted');
  const rows = Array.isArray(req.body.results) ? req.body.results : [];
  const seen = new Set(), maxRP = Math.max(num(m.prize), ...(m.rankPrizes || []), 0);
  rows.forEach(r => {
    const u = db.users[r.uid];
    if (!u || !db.joins.some(x => x.matchId === m.id && x.uid === u.id)) fail('Player not registered in this match: ' + r.uid);
    if (seen.has(u.id)) fail('Duplicate player in results: ' + u.username);
    seen.add(u.id);
    if (num(r.kills) < 0 || num(r.rank) < 0 || num(r.prize) < 0) fail('Negative values not allowed');
    if (num(r.prize) > maxRP) fail('Rank prize for ' + u.username + ' exceeds the prizes configured on this match');
  });
  m.result = [];
  rows.forEach(r => {
    const u = db.users[r.uid]; if (!u) return;
    const j = db.joins.find(x => x.matchId === m.id && x.uid === u.id) || {};
    const kills = Math.floor(num(r.kills)), rank = Math.floor(num(r.rank)), rp = num(r.prize), kp = kills * num(m.perKill), amt = rp + kp;
    u.kills += kills;
    if (amt > 0) { u.win += amt; u.earning += amt; tx(u, 'prize', 'win', amt, 'Winning: ' + m.title); }
    m.result.push({ uid: u.id, username: u.username, ign: j.ign || '', slot: j.slot, pos: j.pos, rank, kills, prize: amt, rankPrize: rp, killPrize: kp });
    notify([u.id], 'Result: ' + m.title, (rank ? 'Rank #' + rank + ' • ' : '') + kills + ' kills' + (amt > 0 ? ' • You won ₹' + amt + ' 🎉' : ''));
  });
  m.result.sort((a, b) => (a.rank || 999) - (b.rank || 999) || b.kills - a.kills);
  m.status = 'resulted'; log('Result published: ' + m.title);
  await save(); res.json({ ok: true });
}));
app.get('/api/admin/withdrawals', wrap(async (req, res) => { admin(req); res.json(db.withdrawals.slice().reverse()); }));
app.post('/api/admin/withdrawal/:id', wrap(async (req, res) => {
  admin(req);
  const w = db.withdrawals.find(x => String(x.id) === req.params.id); if (!w || w.status !== 'pending') fail('Not pending');
  log('Withdraw ' + req.body.action + ' #' + w.id);
  if (req.body.action === 'approve') { w.status = 'approved'; notify([w.uid], 'Withdrawal approved ✅', `₹${w.payout} sent to ${w.upi}`); }
  else { w.status = 'rejected'; const u = db.users[w.uid]; if (u) { u.win += w.amount; tx(u, 'credit', 'win', w.amount, 'Withdraw refund'); } notify([w.uid], 'Withdrawal rejected', `₹${w.amount} refunded to your winning wallet`); }
  await save(); res.json({ ok: true });
}));
app.get('/api/admin/deposits', wrap(async (req, res) => { admin(req); res.json(db.deposits.slice().reverse().slice(0, 200).map(d => ({ ...d, username: db.users[d.uid]?.username }))); }));
app.get('/api/admin/settings', wrap(async (req, res) => { admin(req); res.json(db.settings); }));
app.post('/api/admin/settings', wrap(async (req, res) => {
  admin(req);
  const s = req.body || {};
  ['appName', 'logo', 'announcement', 'maintenanceMsg', 'rules', 'telegram', 'whatsapp', 'about', 'faq', 'terms', 'privacy', 'contact'].forEach(k => { if (typeof s[k] === 'string') db.settings[k] = s[k]; });
  ['dailyReward', 'withdrawFee', 'maxWithdrawPerDay', 'signupBonus', 'referrerBonus', 'referralMinEntry', 'minDeposit', 'maxDeposit', 'minWithdraw'].forEach(k => { if (s[k] !== undefined) db.settings[k] = num(s[k]); });
  if (typeof s.maintenance === 'boolean') db.settings.maintenance = s.maintenance;
  if (s.images && typeof s.images === 'object') { const o = {}; ['loginBg','addCash','refer','promo','wallet','profile'].forEach(k => { if (typeof s.images[k] === 'string' && s.images[k].length < 600) o[k] = s.images[k].trim(); }); db.settings.images = o; }
  if (Array.isArray(s.banners)) db.settings.banners = s.banners.filter(b => b && b.img).slice(0, 10);
  if (Array.isArray(s.depositBonus)) db.settings.depositBonus = s.depositBonus.map(x => ({ dep: num(x.dep), bonus: num(x.bonus) }));
  await save(); res.json({ ok: true });
}));
app.post('/api/admin/notice', wrap(async (req, res) => {
  admin(req);
  const title = String(req.body.title || '').trim(), body = String(req.body.body || '').trim();
  if (!title) fail('Title required');
  db.notices.unshift({ id: uid(), title, body, image: String(req.body.image || ''), at: Date.now() });
  db.notices = db.notices.slice(0, 500);
  const devices = queuePush(null, title, body, req.body.image);
  await save(); res.json({ ok: true, devices });
}));

// ====== EXTRA USER FEATURES ======
app.post('/api/profile', wrap(async (req, res) => {
  const u = user(req);
  if (req.body.ign !== undefined) u.ign = String(req.body.ign).slice(0, 30);
  if (req.body.avatar !== undefined) u.avatar = String(req.body.avatar).slice(0, 4);
  await save(); res.json(pub(u));
}));
app.post('/api/password', wrap(async (req, res) => {
  const u = user(req);
  if (!bcrypt.compareSync(String(req.body.old || ''), u.hash)) fail('Old password wrong');
  if (String(req.body.new || '').length < 6) fail('New password min 6 chars');
  u.hash = bcrypt.hashSync(String(req.body.new), 8); await save(); res.json({ ok: true });
}));
app.post('/api/daily', wrap(async (req, res) => {
  const u = user(req); const r = num(db.settings.dailyReward); const today = new Date().toDateString();
  if (r <= 0) fail('Daily reward off hai');
  if (u.lastDaily === today) fail('Aaj ka reward le liya, kal aana');
  u.lastDaily = today; u.bonus += r; tx(u, 'credit', 'bonus', r, 'Daily reward'); await save();
  res.json({ ok: true, reward: r, user: pub(u) });
}));
app.post('/api/promo', wrap(async (req, res) => {
  const u = user(req); const code = String(req.body.code || '').trim().toUpperCase();
  const p = db.promos.find(x => x.code === code && x.active !== false);
  if (!p) fail('Invalid code');
  if (p.expires && Date.now() > p.expires) fail('Code expired');
  if (p.used.includes(u.id)) fail('Already used');
  if (p.maxUses && p.used.length >= p.maxUses) fail('Code limit reached');
  p.used.push(u.id); u.bonus += num(p.bonus); tx(u, 'credit', 'bonus', num(p.bonus), 'Promo ' + code); await save();
  res.json({ ok: true, bonus: p.bonus, user: pub(u) });
}));
app.get('/api/match/:id', wrap(async (req, res) => {
  const u = user(req); const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('Not found', 404);
  res.json({ ...matchView(m, u), players: db.joins.filter(j => j.matchId === m.id).map(j => j.ign) });
}));
app.get('/api/stats', wrap(async (req, res) => {
  const u = user(req); const wins = db.txns.filter(t => t.uid === u.id && t.type === 'prize').length;
  res.json({ ...pub(u), wins, winRate: u.matches ? Math.round(wins / u.matches * 100) : 0, ign: u.ign || '', avatar: u.avatar || 'a1', dailyDone: u.lastDaily === new Date().toDateString(), referrals: Object.values(db.users).filter(x => x.referredBy === u.id).length });
}));
app.get('/api/top-players', wrap(async (req, res) => {
  user(req); res.json(Object.values(db.users).sort((a, b) => b.earning - a.earning).slice(0, 20).map(u => ({ name: u.username, earning: u.earning, kills: u.kills, matches: u.matches, avatar: u.avatar || 'a1' })));
}));
app.get('/api/tickets', wrap(async (req, res) => { const u = user(req); res.json(db.tickets.filter(t => t.uid === u.id).reverse()); }));
app.post('/api/ticket', wrap(async (req, res) => {
  const u = user(req); const t = db.tickets.find(x => x.id === req.body.id && x.uid === u.id);
  const text = String(req.body.text || '').trim().slice(0, 500); if (!text) fail('Message likho');
  if (t) { t.msgs.push({ from: 'user', text, at: Date.now() }); t.status = 'open'; }
  else db.tickets.push({ id: uid(), uid: u.id, username: u.username, subject: String(req.body.subject || 'Support').slice(0, 60), msgs: [{ from: 'user', text, at: Date.now() }], status: 'open', at: Date.now() });
  await save(); res.json({ ok: true });
}));

// ====== EXTRA ADMIN ======
const log = m => { db.logs.unshift({ m, at: Date.now() }); db.logs = db.logs.slice(0, 300); };
app.get('/api/admin/chart', wrap(async (req, res) => {
  admin(req); const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5); const k = d.toDateString();
    days.push({ day: d.toLocaleDateString('en-IN', { weekday: 'short' }),
      dep: db.deposits.filter(x => x.status === 'approved' && new Date(x.at).toDateString() === k).reduce((a, x) => a + x.amount, 0),
      wd: db.withdrawals.filter(x => x.status === 'approved' && new Date(x.at).toDateString() === k).reduce((a, x) => a + x.amount, 0),
      users: Object.values(db.users).filter(x => new Date(x.createdAt).toDateString() === k).length });
  }
  res.json({ days, logs: db.logs.slice(0, 15) });
}));
app.get('/api/admin/user/:id/detail', wrap(async (req, res) => {
  admin(req); const u = db.users[req.params.id]; if (!u) fail('No user', 404);
  res.json({ ...pub(u), banned: !!u.banned, referredBy: db.users[u.referredBy]?.username || null, referrals: Object.values(db.users).filter(x => x.referredBy === u.id).map(x => x.username), txns: db.txns.filter(t => t.uid === u.id).slice(0, 30), deposits: db.deposits.filter(d => d.uid === u.id), withdrawals: db.withdrawals.filter(w => w.uid === u.id) });
}));
app.post('/api/admin/user/:id/password', wrap(async (req, res) => {
  admin(req); const u = db.users[req.params.id]; if (!u) fail('No user', 404);
  if (String(req.body.password || '').length < 6) fail('Min 6 chars');
  u.hash = bcrypt.hashSync(String(req.body.password), 8); log('Password reset: ' + u.username); await save(); res.json({ ok: true });
}));
app.post('/api/admin/deposit/:id/recheck', wrap(async (req, res) => {
  admin(req); const d = db.deposits.find(x => x.id === req.params.id); if (!d) fail('No deposit', 404);
  await settleDeposit(d); res.json({ status: d.status });
}));
app.post('/api/admin/deposit/:id/approve', wrap(async (req, res) => {
  admin(req); const d = db.deposits.find(x => x.id === req.params.id); if (!d || d.status === 'approved') fail('Cannot approve');
  const u = db.users[d.uid]; u.dep += d.amount; tx(u, 'credit', 'dep', d.amount, 'Manual deposit ' + d.id);
  const b = bonusFor(d.amount); if (b > 0) { u.bonus += b; tx(u, 'credit', 'bonus', b, 'Deposit bonus'); }
  d.status = 'approved'; notify([u.id], 'Deposit successful ✅', `₹${d.amount} added to your wallet`); log('Manual approve deposit ' + d.id); await save(); res.json({ ok: true });
}));
app.get('/api/admin/promos', wrap(async (req, res) => { admin(req); res.json(db.promos); }));
app.post('/api/admin/promo', wrap(async (req, res) => {
  admin(req); const code = String(req.body.code || '').trim().toUpperCase(); if (!code) fail('Code required');
  if (db.promos.some(p => p.code === code)) fail('Code exists');
  db.promos.push({ code, bonus: num(req.body.bonus), maxUses: Math.floor(num(req.body.maxUses)), expires: req.body.expires ? new Date(req.body.expires).getTime() : 0, used: [], active: true });
  log('Promo created ' + code); await save(); res.json({ ok: true });
}));
app.delete('/api/admin/promo/:code', wrap(async (req, res) => { admin(req); db.promos = db.promos.filter(p => p.code !== req.params.code); await save(); res.json({ ok: true }); }));
app.get('/api/admin/tickets', wrap(async (req, res) => { admin(req); res.json(db.tickets.slice().reverse()); }));
app.post('/api/admin/ticket/:id', wrap(async (req, res) => {
  admin(req); const t = db.tickets.find(x => x.id === req.params.id); if (!t) fail('No ticket', 404);
  if (req.body.text) { t.msgs.push({ from: 'admin', text: String(req.body.text).slice(0, 500), at: Date.now() }); notify([t.uid], 'Support replied 💬', String(req.body.text).slice(0, 120)); }
  if (req.body.status) t.status = req.body.status;
  await save(); res.json({ ok: true });
}));
app.post('/api/admin/user/:id/notify', wrap(async (req, res) => {
  admin(req); const u = db.users[req.params.id]; if (!u) fail('No user', 404);
  const title = String(req.body.title || '').trim().slice(0, 80), body = String(req.body.body || '').trim().slice(0, 500);
  if (!title) fail('Title required');
  const devices = notify([u.id], title, body); log('Notification to ' + u.username + ': ' + title);
  await save(); res.json({ ok: true, devices });
}));
// Admin device push subscription (match full alerts)
app.post('/api/admin/push/subscribe', wrap(async (req, res) => {
  admin(req); const s = req.body && req.body.sub;
  if (!pushReady) fail('Push not available', 400);
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 600 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') fail('Invalid subscription');
  const entry = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) }, at: Date.now() };
  db.adminPush = (db.adminPush || []).filter(p => p.endpoint !== s.endpoint).concat(entry).slice(-5);
  await save();
  webpush.sendNotification(entry, JSON.stringify({ title: 'Admin alerts ON 🔔', body: 'Match full hote hi yahan alert milega.', url: '/admin', icon: '', image: '' })).catch(() => {});
  res.json({ ok: true });
}));
app.get('/api/admin/alerts', wrap(async (req, res) => { admin(req); res.json(db.adminAlerts || []); }));
app.get('/api/admin/notices', wrap(async (req, res) => { admin(req); res.json(db.notices); }));
app.delete('/api/admin/notice/:id', wrap(async (req, res) => { admin(req); db.notices = db.notices.filter(n => n.id !== req.params.id); await save(); res.json({ ok: true }); }));
app.delete('/api/admin/match/:id', wrap(async (req, res) => {
  admin(req); const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('No match', 404);
  if (m.status !== 'resulted' && db.joins.some(j => j.matchId === m.id)) fail('Players joined hain, Cancel+Refund use karo');
  db.matches = db.matches.filter(x => x.id !== m.id); db.joins = db.joins.filter(j => j.matchId !== m.id); await save(); res.json({ ok: true });
}));
app.post('/api/admin/broadcast-bonus', wrap(async (req, res) => {
  admin(req); const a = num(req.body.amount); if (a <= 0) fail('Amount?');
  Object.values(db.users).forEach(u => { u.bonus += a; tx(u, 'credit', 'bonus', a, req.body.note || 'Bonus from admin'); });
  log('Broadcast bonus ' + a); await save(); res.json({ ok: true });
}));

// ====== MATCH MANAGE: room / message / kick / move ======
const joinsOf = m => db.joins.filter(j => j.matchId === m.id);
const MM = req => { const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('No match', 404); return m; };
app.post('/api/admin/match/:id/room', wrap(async (req, res) => {
  admin(req); const m = MM(req);
  m.roomId = String(req.body.roomId || ''); m.roomPass = String(req.body.roomPass || '');
  if (req.body.notify) notify(joinsOf(m).map(j => j.uid), 'Room details: ' + m.title, 'Room ID: ' + m.roomId + '\nPassword: ' + m.roomPass);
  log('Room updated: ' + m.title); await save(); res.json({ ok: true });
}));
app.post('/api/admin/match/:id/message', wrap(async (req, res) => {
  admin(req); const m = MM(req); const body = String(req.body.body || '').trim(); if (!body) fail('Message likho');
  const to = req.body.uid ? [String(req.body.uid)] : joinsOf(m).map(j => j.uid);
  notify(to, String(req.body.title || m.title), body); await save(); res.json({ ok: true, sent: to.length });
}));
app.post('/api/admin/match/:id/kick', wrap(async (req, res) => {
  admin(req); const m = MM(req); const j = joinsOf(m).find(x => x.uid === req.body.uid); if (!j) fail('Player not found');
  const u = db.users[j.uid];
  if (u) { u.dep += num(m.fee); u.matches = Math.max(0, u.matches - 1); tx(u, 'credit', 'dep', num(m.fee), 'Refund (removed): ' + m.title); notify([u.id], 'Removed from match', m.title + ' se aapko hata diya gaya. Fee refund ho gayi.'); }
  db.joins = db.joins.filter(x => x !== j); m.fullNotified = false; log('Kick ' + (u && u.username) + ' from ' + m.title); await save(); res.json({ ok: true });
}));
app.post('/api/admin/match/:id/move', wrap(async (req, res) => {
  admin(req); const m = MM(req); const j = joinsOf(m).find(x => x.uid === req.body.uid); if (!j) fail('Player not found');
  const sz = sizeOf(m), slot = Math.floor(num(req.body.slot)), pos = Math.floor(num(req.body.pos));
  if (slot < 1 || slot > m.slots || pos < 0 || pos >= sz) fail('Slot galat hai');
  if (joinsOf(m).some(x => x !== j && x.slot === slot && x.pos === pos)) fail('Slot already booked');
  j.slot = slot; j.pos = pos; await save(); res.json({ ok: true });
}));

// ====== IMAGE UPLOAD (Redis me store, /img/:id se serve) ======
app.post('/api/admin/upload', wrap(async (req, res) => {
  admin(req); const d = String(req.body.data || '');
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(d);
  if (!m) fail('Only PNG, JPG, WEBP or GIF images are allowed');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 650 * 1024) fail('Image too large (max 650 KB)');
  const h = buf.subarray(0, 12), ascii = (a, b) => h.toString('ascii', a, b);
  if (!((h[0] === 0x89 && ascii(1, 4) === 'PNG') || (h[0] === 0xFF && h[1] === 0xD8) || ascii(0, 3) === 'GIF' || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'))) fail('File content is not a valid image');
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    const ts = Math.floor(Date.now() / 1000), folder = 'arena';
    const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${ts}${CLOUDINARY_API_SECRET}`).digest('hex');
    const form = new FormData(); form.append('file', d); form.append('api_key', CLOUDINARY_API_KEY); form.append('timestamp', String(ts)); form.append('folder', folder); form.append('signature', signature);
    let j; try { const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, { method: 'POST', body: form }); j = await r.json(); if (!r.ok || !j.secure_url) throw new Error((j.error && j.error.message) || 'upload rejected'); }
    catch (e) { fail('Image storage failed: ' + e.message, 502); }
    log('Image uploaded (cloudinary)'); await save();
    return res.json({ url: j.secure_url, storage: 'cloudinary', bytes: buf.length });
  }
  if (ALLOW_REDIS_IMAGES !== '1') fail('Image storage is not configured. Set CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in Render (see README).', 503);
  const id = uid() + uid(); await redis.set('img:' + id, d); res.json({ url: '/img/' + id, storage: 'redis-legacy', bytes: buf.length });
}));
app.get('/img/:id', async (req, res) => {
  try {
    const d = await redis.get('img:' + req.params.id.replace(/[^a-z0-9]/gi, ''));
    if (!d || typeof d !== 'string') return res.status(404).end();
    res.set({ 'Content-Type': d.slice(5, d.indexOf(';')), 'Cache-Control': 'public,max-age=31536000,immutable' });
    res.send(Buffer.from(d.slice(d.indexOf(',') + 1), 'base64'));
  } catch { res.status(500).end(); }
});

app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '1h' }));
app.get('/admin', (q, r) => r.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/favicon.ico', (q, r) => r.status(204).end());
app.get('/health', (q, r) => r.send('ok'));

if (require.main === module) load().then(initPush).then(() => { runAutoMatches(); setInterval(runAutoMatches, 30e3); return app.listen(PORT, () => console.log('Running on', PORT)); }).catch(e => { console.error('Startup failed (Redis unreachable?):', e.message); process.exit(1); });
module.exports = { app, load, getDb: () => db, autoProcessMatches };
