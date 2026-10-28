const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Redis } = require('@upstash/redis');

// ====== ENV (Render me set karo) ======
// UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// JWT_SECRET, ADMIN_USER, ADMIN_PASS
// ZAPUPI_TOKEN, ZAPUPI_SECRET, BASE_URL (e.g. https://yourapp.onrender.com)
// ZAPUPI_API (optional, default below) - Zapupi docs se verify karo
const {
  JWT_SECRET = 'change-me', ADMIN_USER = 'admin', ADMIN_PASS = 'admin123',
  ZAPUPI_TOKEN, ZAPUPI_SECRET, BASE_URL = '',
  ZAPUPI_API = 'https://api.zapupi.com/api', PORT = 3000
} = process.env;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const DEFAULT = () => ({
  users: {}, games: [
    { id: 'g1', name: 'BR SURVIVAL', image: '' },
    { id: 'g2', name: 'PER KILL MATCHES', image: '' },
    { id: 'g3', name: 'LONE WOLF 2v2', image: '' }
  ],
  matches: [], joins: [], deposits: [], withdrawals: [], txns: [], notices: [],
  settings: {
    appName: 'Arena Battle', logo: '', announcement: 'Welcome! Fair play karo.',
    signupBonus: 0, referrerBonus: 0, referralMinEntry: 0,
    minDeposit: 10, maxDeposit: 1000, minWithdraw: 50,
    depositBonus: [{ dep: 50, bonus: 10 }, { dep: 100, bonus: 20 }, { dep: 200, bonus: 40 }, { dep: 300, bonus: 50 }, { dep: 500, bonus: 100 }],
    about: 'About us', faq: 'FAQ', terms: 'Terms & Conditions', privacy: 'Privacy Policy', contact: 'support@example.com'
  }
});

let db = null;
let chain = Promise.resolve();
const lock = fn => (chain = chain.then(fn, fn));
async function load() {
  db = (await redis.get('arenadb')) || DEFAULT();
  if (typeof db === 'string') db = JSON.parse(db);
}
const save = () => redis.set('arenadb', JSON.stringify(db));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const num = (v, d = 0) => (isFinite(+v) ? +v : d);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

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
  db.txns = db.txns.slice(0, 5000);
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
  res.json({ appName: s.appName, logo: s.logo, announcement: s.announcement, depositBonus: s.depositBonus, minDeposit: s.minDeposit, maxDeposit: s.maxDeposit, minWithdraw: s.minWithdraw, referrerBonus: s.referrerBonus, signupBonus: s.signupBonus, referralMinEntry: s.referralMinEntry, about: s.about, faq: s.faq, terms: s.terms, privacy: s.privacy, contact: s.contact });
}));

app.get('/api/games', wrap(async (req, res) => {
  res.json(db.games.map(g => ({ ...g, count: db.matches.filter(m => m.gameId === g.id && m.status === 'upcoming').length })));
}));

const matchView = (m, u) => {
  const joined = db.joins.filter(j => j.matchId === m.id);
  const mine = u && joined.find(j => j.uid === u.id);
  return { id: m.id, gameId: m.gameId, title: m.title, image: m.image, time: m.time, prize: m.prize, perKill: m.perKill, fee: m.fee, type: m.type, map: m.map, slots: m.slots, filled: joined.length, status: m.status, joined: !!mine, room: mine && m.status !== 'resulted' ? { id: m.roomId, pass: m.roomPass } : null, result: m.status === 'resulted' ? m.result : null };
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
  const joined = db.joins.filter(j => j.matchId === m.id);
  if (joined.some(j => j.uid === u.id)) fail('Already joined');
  if (joined.length >= m.slots) fail('Joining full');
  const fee = num(m.fee);
  if (total(u) < fee) fail('Insufficient balance. Recharge karo.');
  let rem = fee;
  for (const w of ['dep', 'bonus', 'win']) { const t = Math.min(u[w], rem); if (t > 0) { u[w] -= t; rem -= t; tx(u, 'debit', w, t, 'Joined ' + m.title); } }
  db.joins.push({ id: uid(), matchId: m.id, uid: u.id, ign, at: Date.now() });
  u.matches++;
  // referral reward on first paid match
  if (fee > 0 && fee >= num(db.settings.referralMinEntry) && u.referredBy && !u.refPaid) {
    const r = db.users[u.referredBy]; const rb = num(db.settings.referrerBonus);
    u.refPaid = true;
    if (r && rb > 0) { r.bonus += rb; tx(r, 'credit', 'bonus', rb, 'Referral reward: ' + u.username); }
  }
  await save();
  res.json({ ok: true, user: pub(u) });
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

app.get('/api/notifications', wrap(async (req, res) => { user(req); res.json(db.notices.slice(0, 50)); }));

// ====== DEPOSIT (ZAPUPI) ======
function bonusFor(amount) {
  const t = db.settings.depositBonus.filter(x => amount >= x.dep).sort((a, b) => b.dep - a.dep)[0];
  return t ? num(t.bonus) : 0;
}
app.post('/api/deposit', wrap(async (req, res) => {
  const u = user(req);
  const amount = Math.floor(num(req.body.amount));
  if (amount < db.settings.minDeposit || amount > db.settings.maxDeposit) fail(`Amount ${db.settings.minDeposit}-${db.settings.maxDeposit}`);
  if (!ZAPUPI_TOKEN || !ZAPUPI_SECRET) fail('Payment gateway not configured', 500);
  const orderId = String(Math.floor(1e5 + Math.random() * 9e5)) + Date.now().toString().slice(-4);
  // NOTE: Zapupi ke latest docs se field names verify karo
  const body = new URLSearchParams({
    token_key: ZAPUPI_TOKEN, secret_key: ZAPUPI_SECRET, amount: String(amount),
    order_id: orderId, custom_mobile: '9999999999', redirect_url: `${BASE_URL}/?paid=${orderId}`,
    remark: u.id
  });
  const r = await fetch(`${ZAPUPI_API}/create-order`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  const url = j.payment_url || j.data?.payment_url || j.url;
  if (!url) fail('Gateway error: ' + (j.message || 'try again'), 502);
  db.deposits.push({ id: orderId, uid: u.id, amount, status: 'pending', at: Date.now() });
  await save();
  res.json({ orderId, url });
}));

async function settleDeposit(d) {
  if (d.status !== 'pending') return d;
  const r = await fetch(`${ZAPUPI_API}/order-status`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token_key: ZAPUPI_TOKEN, secret_key: ZAPUPI_SECRET, order_id: d.id }) });
  const j = await r.json().catch(() => ({}));
  const st = String(j.status || j.data?.status || '').toLowerCase();
  const ok = ['success', 'completed', 'paid', 'approved'].includes(st);
  if (ok) {
    const u = db.users[d.uid];
    u.dep += d.amount; tx(u, 'credit', 'dep', d.amount, 'Deposit of orderId: ' + d.id);
    const b = bonusFor(d.amount);
    if (b > 0) { u.bonus += b; tx(u, 'credit', 'bonus', b, 'Deposit bonus'); }
    d.status = 'approved';
    await save();
  } else if (['failed', 'cancelled', 'expired'].includes(st)) { d.status = 'failed'; await save(); }
  return d;
}
app.get('/api/deposit/check/:id', wrap(async (req, res) => {
  const u = user(req);
  const d = db.deposits.find(x => x.id === req.params.id && x.uid === u.id);
  if (!d) fail('Not found', 404);
  await settleDeposit(d);
  res.json({ status: d.status, user: pub(u) });
}));
// Zapupi webhook: sirf order_id lete hain, asli verification status API se hota hai
app.all('/api/zapupi/webhook', wrap(async (req, res) => {
  const id = req.body.order_id || req.query.order_id;
  const d = db.deposits.find(x => x.id === String(id));
  if (d) await settleDeposit(d);
  res.json({ ok: true });
}));

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
  u.win -= amount; tx(u, 'debit', 'win', amount, 'Withdraw request');
  db.withdrawals.push({ id: Math.floor(1e4 + Math.random() * 9e4), uid: u.id, username: u.username, method, upi, amount, status: 'pending', at: Date.now() });
  await save();
  res.json({ ok: true, user: pub(u) });
}));

// ====== ADMIN ======
app.post('/api/admin/login', wrap(async (req, res) => {
  if (req.body.username !== ADMIN_USER || req.body.password !== ADMIN_PASS) fail('Wrong admin login', 401);
  res.json({ token: jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' }) });
}));
app.get('/api/admin/stats', wrap(async (req, res) => {
  admin(req);
  res.json({ users: Object.keys(db.users).length, matches: db.matches.length, pendingWithdraw: db.withdrawals.filter(w => w.status === 'pending').length, depositTotal: db.deposits.filter(d => d.status === 'approved').reduce((a, d) => a + d.amount, 0), withdrawTotal: db.withdrawals.filter(w => w.status === 'approved').reduce((a, d) => a + d.amount, 0) });
}));
app.get('/api/admin/users', wrap(async (req, res) => { admin(req); res.json(Object.values(db.users).map(u => ({ ...pub(u), banned: !!u.banned, createdAt: u.createdAt }))); }));
app.post('/api/admin/user/:id', wrap(async (req, res) => {
  admin(req);
  const u = db.users[req.params.id]; if (!u) fail('No user', 404);
  const { action, wallet = 'dep', amount = 0 } = req.body;
  if (action === 'ban') u.banned = true;
  else if (action === 'unban') u.banned = false;
  else if (action === 'add' && ['dep', 'win', 'bonus'].includes(wallet)) { u[wallet] += num(amount); tx(u, 'credit', wallet, num(amount), 'Admin credit'); }
  else if (action === 'deduct' && ['dep', 'win', 'bonus'].includes(wallet)) { u[wallet] = Math.max(0, u[wallet] - num(amount)); tx(u, 'debit', wallet, num(amount), 'Admin debit'); }
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
  res.json(db.matches.slice().reverse().map(m => ({ ...m, players: db.joins.filter(j => j.matchId === m.id).map(j => ({ uid: j.uid, ign: j.ign, username: db.users[j.uid]?.username })) })));
}));
app.post('/api/admin/match', wrap(async (req, res) => {
  admin(req);
  const b = req.body;
  const data = { gameId: b.gameId, title: String(b.title || ''), image: b.image || '', time: new Date(b.time).getTime() || Date.now(), prize: num(b.prize), perKill: num(b.perKill), fee: num(b.fee), type: b.type || 'Solo', map: b.map || '', slots: Math.max(1, Math.floor(num(b.slots, 20))), roomId: b.roomId || '', roomPass: b.roomPass || '' };
  if (b.id) { const m = db.matches.find(x => x.id === b.id); if (!m) fail('No match', 404); Object.assign(m, data); }
  else db.matches.push({ id: uid(), status: 'upcoming', ...data });
  await save(); res.json({ ok: true });
}));
app.post('/api/admin/match/:id/status', wrap(async (req, res) => {
  admin(req);
  const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('No match', 404);
  if (['upcoming', 'ongoing'].includes(req.body.status)) m.status = req.body.status;
  await save(); res.json({ ok: true });
}));
app.post('/api/admin/match/:id/cancel', wrap(async (req, res) => {
  admin(req);
  const m = db.matches.find(x => x.id === req.params.id); if (!m || m.status === 'resulted') fail('Cannot cancel');
  db.joins.filter(j => j.matchId === m.id).forEach(j => { const u = db.users[j.uid]; if (u) { u.dep += num(m.fee); u.matches = Math.max(0, u.matches - 1); tx(u, 'credit', 'dep', num(m.fee), 'Refund: ' + m.title); } });
  db.joins = db.joins.filter(j => j.matchId !== m.id);
  db.matches = db.matches.filter(x => x.id !== m.id);
  await save(); res.json({ ok: true });
}));
// results: [{uid, kills, prize}]
app.post('/api/admin/match/:id/result', wrap(async (req, res) => {
  admin(req);
  const m = db.matches.find(x => x.id === req.params.id); if (!m) fail('No match', 404);
  if (m.status === 'resulted') fail('Already resulted');
  const rows = Array.isArray(req.body.results) ? req.body.results : [];
  m.result = [];
  rows.forEach(r => {
    const u = db.users[r.uid]; if (!u) return;
    const kills = Math.floor(num(r.kills)); const amt = num(r.prize) + kills * num(m.perKill);
    u.kills += kills;
    if (amt > 0) { u.win += amt; u.earning += amt; tx(u, 'prize', 'win', amt, 'Winning: ' + m.title); }
    m.result.push({ username: u.username, kills, prize: amt });
  });
  m.status = 'resulted';
  await save(); res.json({ ok: true });
}));
app.get('/api/admin/withdrawals', wrap(async (req, res) => { admin(req); res.json(db.withdrawals.slice().reverse()); }));
app.post('/api/admin/withdrawal/:id', wrap(async (req, res) => {
  admin(req);
  const w = db.withdrawals.find(x => String(x.id) === req.params.id); if (!w || w.status !== 'pending') fail('Not pending');
  if (req.body.action === 'approve') w.status = 'approved';
  else { w.status = 'rejected'; const u = db.users[w.uid]; if (u) { u.win += w.amount; tx(u, 'credit', 'win', w.amount, 'Withdraw refund'); } }
  await save(); res.json({ ok: true });
}));
app.get('/api/admin/deposits', wrap(async (req, res) => { admin(req); res.json(db.deposits.slice().reverse().slice(0, 200).map(d => ({ ...d, username: db.users[d.uid]?.username }))); }));
app.get('/api/admin/settings', wrap(async (req, res) => { admin(req); res.json(db.settings); }));
app.post('/api/admin/settings', wrap(async (req, res) => {
  admin(req);
  const s = req.body || {};
  ['appName', 'logo', 'announcement', 'about', 'faq', 'terms', 'privacy', 'contact'].forEach(k => { if (typeof s[k] === 'string') db.settings[k] = s[k]; });
  ['signupBonus', 'referrerBonus', 'referralMinEntry', 'minDeposit', 'maxDeposit', 'minWithdraw'].forEach(k => { if (s[k] !== undefined) db.settings[k] = num(s[k]); });
  if (Array.isArray(s.depositBonus)) db.settings.depositBonus = s.depositBonus.map(x => ({ dep: num(x.dep), bonus: num(x.bonus) }));
  await save(); res.json({ ok: true });
}));
app.post('/api/admin/notice', wrap(async (req, res) => {
  admin(req);
  db.notices.unshift({ id: uid(), title: String(req.body.title || ''), body: String(req.body.body || ''), at: Date.now() });
  await save(); res.json({ ok: true });
}));

app.get('/admin', (q, r) => r.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (q, r) => r.send('ok'));

load().then(() => app.listen(PORT, () => console.log('Running on', PORT)));
