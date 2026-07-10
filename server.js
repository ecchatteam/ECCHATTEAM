const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const XLSX    = require('xlsx');
const crypto  = require('crypto');
const db      = require('./db');

const app        = express();
const PORT       = process.env.PORT || 4000;

// ── Morning digest config (fill in to enable) ────────────────
// Works with any webhook that accepts {"text": "..."} — this matches
// Slack incoming webhooks and Zoho Cliq incoming webhooks.
const REMINDER_CONFIG = {
  enabled:    process.env.REMINDER_ENABLED    !== 'false',
  webhookUrl: process.env.REMINDER_WEBHOOK_URL || '',
  time:       process.env.REMINDER_TIME        || '06:00', // HH:MM in IST
  toolUrl:    process.env.REMINDER_TOOL_URL     || 'http://<server-ip>:4000'
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Seed the master roster from your screenshot on first run ─
const SEED_ROSTER = {
  cycleStart: '05:00',
  people: [
    { id: 'r1',  name: 'Arun R',             region: 'ANZ/APAC'   },
    { id: 'r2',  name: 'Gokulakrishnan P',   region: 'ANZ/APAC'   },
    { id: 'r3',  name: 'Premnath V',         region: 'APAC/India' },
    { id: 'r4',  name: 'Tamilselvan G',      region: 'APAC/India' },
    { id: 'r5',  name: 'Subbu',              region: 'India/MEA'  },
    { id: 'r6',  name: 'Manoj Kumar',        region: 'India/MEA'  },
    { id: 'r7',  name: 'Prasanth Ganesan',   region: 'India/MEA'  },
    { id: 'r8',  name: 'Anto',               region: 'India/MEA'  },
    { id: 'r9',  name: 'Kewin',              region: 'MEA/Europe' },
    { id: 'r10', name: 'Santhoshraj V',      region: 'MEA/Europe' },
    { id: 'r11', name: 'Sabrishwaran',       region: 'UK/Europe'  },
    { id: 'r12', name: 'Vinoth Kumar',       region: 'UK/Europe'  },
    { id: 'r13', name: 'Arunkumar E',        region: 'UK/Europe'  },
    { id: 'r14', name: 'Prabhakaran K',      region: 'US/LATAM'   },
    { id: 'r15', name: 'Lokesh',             region: 'US/LATAM'   },
    { id: 'r16', name: 'Rahul Muthiah V',    region: 'US/LATAM'   },
    { id: 'r17', name: 'Abinaya K',          region: 'US/LATAM'   },
    { id: 'r18', name: 'Guna',               region: 'US/LATAM'   },
    { id: 'r19', name: 'Santhosh L',         region: 'US/LATAM'   },
    { id: 'r20', name: 'Ranjith Kumar R',    region: 'US/LATAM'   }
  ]
};
function seedAll() {
  if (!db.has('roster')) {
    db.set('roster', SEED_ROSTER);
  }

  if (!db.has('trackerRoster')) {
    db.set('trackerRoster', SEED_TRACKER_ROSTER);
  }

  // Migration for installs provisioned before the "shift" field existed
  // (e.g. your production tracker-roster.json) — fills in only what's
  // missing, never touches mode/region/id that may have been edited since.
  (function migrateShiftField() {
    if (!db.has('trackerRoster')) return;
    try {
      const current = db.get('trackerRoster');
      if (!current) return;
      const byId = {};
      SEED_TRACKER_ROSTER.people.forEach(p => { byId[p.id] = p.shift; });
      let changed = false;
      (current.people || []).forEach(p => {
        if (!p.shift) { p.shift = byId[p.id] || ''; changed = true; }
      });
      if (changed) {
        db.set('trackerRoster', current);
        console.log('[tracker] Backfilled missing "shift" field on tracker roster');
      }
    } catch (e) { /* leave data untouched if it can't be parsed */ }
  })();

  // ── Seed the default admin account on first run (guest needs no
  // password at all — it's a one-click view-only login) ─────────
  if (!db.has('users')) {
    const seedUsers = {
      admin: makeUserRecord('admin', DEFAULT_ADMIN_PASSWORD, 'admin')
    };
    writeUsers(seedUsers);
    console.log(`[users] Created default admin account — admin/${DEFAULT_ADMIN_PASSWORD}. Please change this password after first login.`);
  }

  ensureEbsAccounts();
}

// ── Seed the tracker roster (same 20 people, tagged EBS/SMB per your
// screenshot) — lives in its own file so editing it never touches the
// master shift roster above ──────────────────────────────────
const SEED_TRACKER_ROSTER = {
  people: [
    { id: 'r1',  name: 'Arun R',             region: 'ANZ/APAC',   mode: 'SMB', shift: '05:00' },
    { id: 'r2',  name: 'Gokulakrishnan P',   region: 'ANZ/APAC',   mode: 'SMB', shift: '06:00' },
    { id: 'r3',  name: 'Premnath V',         region: 'APAC/India', mode: 'SMB', shift: '07:00' },
    { id: 'r4',  name: 'Tamilselvan G',      region: 'APAC/India', mode: 'SMB', shift: '08:00' },
    { id: 'r5',  name: 'Subbu',              region: 'India/MEA',  mode: 'EBS', shift: '10:00' },
    { id: 'r6',  name: 'Manoj Kumar',        region: 'India/MEA',  mode: 'SMB', shift: '10:00' },
    { id: 'r7',  name: 'Prasanth Ganesan',   region: 'India/MEA',  mode: 'SMB', shift: '10:00' },
    { id: 'r8',  name: 'Anto',               region: 'India/MEA',  mode: 'EBS', shift: '11:00' },
    { id: 'r9',  name: 'Kewin',              region: 'MEA/Europe', mode: 'EBS', shift: '11:00' },
    { id: 'r10', name: 'Santhoshraj V',      region: 'MEA/Europe', mode: 'SMB', shift: '13:00' },
    { id: 'r11', name: 'Sabrishwaran',       region: 'UK/Europe',  mode: 'SMB', shift: '13:00' },
    { id: 'r12', name: 'Vinoth Kumar',       region: 'UK/Europe',  mode: 'EBS', shift: '13:00' },
    { id: 'r13', name: 'Arunkumar E',        region: 'UK/Europe',  mode: 'SMB', shift: '14:00' },
    { id: 'r14', name: 'Prabhakaran K',      region: 'US/LATAM',   mode: 'SMB', shift: '16:00' },
    { id: 'r15', name: 'Lokesh',             region: 'US/LATAM',   mode: 'EBS', shift: '16:00' },
    { id: 'r16', name: 'Rahul Muthiah V',    region: 'US/LATAM',   mode: 'SMB', shift: '17:00' },
    { id: 'r17', name: 'Abinaya K',          region: 'US/LATAM',   mode: 'SMB', shift: '19:00' },
    { id: 'r18', name: 'Guna',               region: 'US/LATAM',   mode: 'EBS', shift: '19:00' },
    { id: 'r19', name: 'Santhosh L',         region: 'US/LATAM',   mode: 'SMB', shift: '20:00' },
    { id: 'r20', name: 'Ranjith Kumar R',    region: 'US/LATAM',   mode: 'SMB', shift: '21:00' }
  ]
};

// ── Auth: password hashing helpers ────────────────────────────
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  const attempt = hashPassword(password, salt);
  const a = Buffer.from(attempt, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function makeUserRecord(username, password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { username, role, salt, hash: hashPassword(password, salt) };
}
function readUsers() {
  return db.get('users', {});
}
function writeUsers(users) {
  db.set('users', users);
}

// ── Seed the default admin account on first run (guest needs no
// password at all — it's a one-click view-only login) ─────────
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ── Auto-provision one login per EBS tech (runs every boot, only adds
// accounts that don't exist yet — never touches an existing password,
// including one you've already changed). This is what lets each EBS
// tech log in as themselves instead of self-selecting from a dropdown,
// so Guest can no longer "become" Subbu/Guna/etc. ───────────────────
function usernameFor(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function ensureEbsAccounts() {
  const roster = readTrackerRoster();
  const ebsPeople = roster.people.filter(p => p.mode === 'EBS');
  if (ebsPeople.length === 0) return;
  const users = readUsers();
  let changed = false;
  ebsPeople.forEach(p => {
    const username = usernameFor(p.name);
    if (!username || users[username]) return; // already exists — never overwrite
    const defaultPassword = `${username}123`;
    users[username] = {
      ...makeUserRecord(username, defaultPassword, 'ebs'),
      ebsId: p.id,
      displayName: p.name
    };
    changed = true;
    console.log(`[users] Created EBS account "${username}" / ${defaultPassword} — linked to ${p.name}. Please have them change this password after first login.`);
  });
  if (changed) writeUsers(users);
}

// ── Auth: sessions (in-memory, cookie-based — no extra npm deps) ─
const sessions = new Map(); // token -> { username, role, expiresAt }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
function createSession(username, role) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, role, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) { sessions.delete(token); return null; }
  return { token, ...sess };
}
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions) if (now > sess.expiresAt) sessions.delete(token);
}, 30 * 60 * 1000);

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ success: false, message: 'Please log in.' });
  req.session = session;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required for this action.' });
  }
  next();
}
// Guest is strictly view-only for the chat assignment tracker — only
// Admin or a logged-in EBS tech may log an assignment.
function requireAssignAccess(req, res, next) {
  if (!req.session || (req.session.role !== 'admin' && req.session.role !== 'ebs')) {
    return res.status(403).json({ success: false, message: 'View-only access — sign in as an EBS tech or Admin to log a chat assignment.' });
  }
  next();
}

// ── Helpers: dates & files ───────────────────────────────────
function isValidDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }
function scheduleExists(date) { return db.has(`schedule:${date}`); }
function readSavedSchedule(date) { return db.get(`schedule:${date}`, null); }
function writeSchedule(date, rows) { db.set(`schedule:${date}`, rows); }

// ── Helpers: IST time ─────────────────────────────────────────
function istTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}
function istNowHHMM() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}`;
}
function addDaysISO(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timeToMinutes(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function fmtHHMM24(totalMin) {
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
}
function fmt12(totalMin) {
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

// ── Master roster helpers ─────────────────────────────────────
function readRoster() {
  return db.get('roster', { cycleStart: '05:00', people: [] });
}
function writeRoster(roster) {
  db.set('roster', roster);
}
function genId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Tracker roster helpers (SMB Chat Assignment Live Tracker) ─
function readTrackerRoster() {
  return db.get('trackerRoster', { people: [] });
}
function writeTrackerRoster(roster) {
  db.set('trackerRoster', roster);
}
function readTrackerDay(date) {
  return db.get(`tracker:${date}`, { events: [] });
}
function writeTrackerDay(date, day) {
  db.set(`tracker:${date}`, day);
}
function genEventId() { return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// Build the summary the frontend needs: total per SMB tech, total per
// EBS tech (who's been busiest assigning), and the full EBS×SMB matrix.
function summarizeTrackerDay(day) {
  const countsBySmb = {};
  const totalsByEbs = {};
  const matrix = {}; // matrix[ebsId][smbId] = count
  (day.events || []).forEach(ev => {
    countsBySmb[ev.smbId] = (countsBySmb[ev.smbId] || 0) + 1;
    totalsByEbs[ev.ebsId] = (totalsByEbs[ev.ebsId] || 0) + 1;
    if (!matrix[ev.ebsId]) matrix[ev.ebsId] = {};
    matrix[ev.ebsId][ev.smbId] = (matrix[ev.ebsId][ev.smbId] || 0) + 1;
  });
  return {
    events: day.events || [],
    countsBySmb,
    totalsByEbs,
    matrix,
    totalToday: (day.events || []).length
  };
}

// ── Core scheduler: evenly stretch the 24h cycle across whoever's
// present, in the given order. On-leave people keep their spot in the
// list (so toggling them back is a one-click undo) but get no time slot.
function computeSchedule(cycleStartHHMM, orderedPeople) {
  const startMin = timeToMinutes(cycleStartHHMM) ?? 300; // default 05:00
  const present = orderedPeople.filter(p => !p.onLeave);
  const n = present.length;

  if (n === 0) {
    return orderedPeople.map(p => ({ ...p, shiftSlot: '', ticketTimeWindow: '' }));
  }

  const base = Math.floor(1440 / n);
  const remainder = 1440 - base * n; // absorbed by the last present person so slices always total exactly 24h
  const timesById = {};
  let cursor = startMin;
  present.forEach((p, idx) => {
    const dur = base + (idx === n - 1 ? remainder : 0);
    const startAbs = cursor;
    const endAbs = cursor + dur;
    timesById[p.id] = {
      shiftSlot: fmtHHMM24(startAbs),
      // display end 1 minute early, matching the "ends :12, next starts :13" convention from your original roster
      ticketTimeWindow: `${fmt12(startAbs)} - ${fmt12(endAbs - 1)}`,
      durationMin: dur
    };
    cursor = endAbs;
  });

  return orderedPeople.map(p => p.onLeave
    ? { ...p, shiftSlot: '', ticketTimeWindow: '', durationMin: null }
    : { ...p, ...timesById[p.id] }
  );
}

// Build the default day sequence straight from the master roster (used
// whenever a day has no saved override yet — nobody on leave, roster order)
function defaultDaySequence() {
  const roster = readRoster();
  return roster.people.map(p => ({ id: p.id, name: p.name, region: p.region, onLeave: false }));
}

// Older saved schedule files (from before the Duration column existed)
// won't have a durationMin field yet — derive it from the display window
// so old dates still show a correct value, and persist the fix once.
function deriveDurationFromWindow(win) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(String(win || '').trim());
  if (!m) return null;
  function to24(h, ap) { h = parseInt(h, 10); ap = ap.toUpperCase(); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return h; }
  const start = to24(m[1], m[3]) * 60 + parseInt(m[2], 10);
  let end = to24(m[4], m[6]) * 60 + parseInt(m[5], 10) + 1; // display end is 1 min before the real boundary
  if (end <= start) end += 1440; // wraps past midnight
  return end - start;
}
function backfillDurations(rows) {
  let changed = false;
  const fixed = rows.map(r => {
    if (r.onLeave) {
      if (r.durationMin !== null && r.durationMin !== undefined) { changed = true; return { ...r, durationMin: null }; }
      return r;
    }
    if (typeof r.durationMin === 'number') return r;
    changed = true;
    return { ...r, durationMin: deriveDurationFromWindow(r.ticketTimeWindow) };
  });
  return { rows: fixed, changed };
}

function getOrBuildDayRows(date) {
  const saved = readSavedSchedule(date);
  if (saved) {
    const { rows: fixed, changed } = backfillDurations(saved);
    if (changed) writeSchedule(date, fixed); // one-time, on-read migration
    return fixed;
  }
  const roster = readRoster();
  return computeSchedule(roster.cycleStart, defaultDaySequence());
}

// ── Auth routes ─────────────────────────────────────────────
// Admin needs a password. Guest is a one-click, no-password, view-only login.
app.post('/api/login/admin', (req, res) => {
  const { password } = req.body || {};
  const users = readUsers();
  const record = users.admin;
  if (!record || !verifyPassword(String(password || ''), record.salt, record.hash)) {
    return res.status(401).json({ success: false, message: 'Incorrect admin password.' });
  }
  const token = createSession(record.username, record.role);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  console.log(`[auth] admin logged in`);
  res.json({ success: true, username: record.username, role: record.role });
});

app.post('/api/login/guest', (req, res) => {
  const token = createSession('guest', 'guest');
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  console.log(`[auth] guest logged in`);
  res.json({ success: true, username: 'guest', role: 'guest' });
});

// Public — lists EBS tech display names for the login picker only
// (no counts, no assignment data; just enough to build the dropdown).
app.get('/api/login/ebs-list', (req, res) => {
  const users = readUsers();
  const list = Object.values(users)
    .filter(u => u.role === 'ebs')
    .map(u => ({ username: u.username, name: u.displayName || u.username }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ success: true, people: list });
});

app.post('/api/login/ebs', (req, res) => {
  const { username, password } = req.body || {};
  const users = readUsers();
  const record = users[String(username || '').toLowerCase()];
  if (!record || record.role !== 'ebs' || !verifyPassword(String(password || ''), record.salt, record.hash)) {
    return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
  }
  const token = createSession(record.username, record.role);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  console.log(`[auth] ${record.displayName || record.username} (EBS) logged in`);
  res.json({ success: true, username: record.username, role: record.role, ebsId: record.ebsId, name: record.displayName || record.username });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).sid;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ success: false });
  const users = readUsers();
  const record = users[session.username];
  res.json({
    success: true,
    username: session.username,
    role: session.role,
    ebsId: record && record.ebsId ? record.ebsId : null,
    name: record && record.displayName ? record.displayName : session.username
  });
});

// Any logged-in user with a real password (admin or ebs — not guest,
// which has none) can change their own password.
app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ success: false, message: 'New password must be at least 4 characters.' });
  }
  const users = readUsers();
  const record = users[req.session.username];
  if (!record || record.role === 'guest') {
    return res.status(400).json({ success: false, message: 'This account has no password to change.' });
  }
  if (!verifyPassword(String(currentPassword || ''), record.salt, record.hash)) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  users[req.session.username] = { ...record, salt, hash: hashPassword(String(newPassword), salt) };
  writeUsers(users);
  console.log(`[auth] ${record.displayName || req.session.username} changed their password`);
  res.json({ success: true });
});

// Admin-only — reset any EBS tech's password without needing the old one
// (for the inevitable "I forgot my password" case). Cannot be used to
// touch the admin account itself; that always requires the current password.
app.post('/api/admin/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { username, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ success: false, message: 'New password must be at least 4 characters.' });
  }
  const users = readUsers();
  const target = String(username || '').toLowerCase();
  const record = users[target];
  if (!record || record.role !== 'ebs') {
    return res.status(404).json({ success: false, message: 'EBS account not found.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  users[target] = { ...record, salt, hash: hashPassword(String(newPassword), salt) };
  writeUsers(users);
  console.log(`[auth] Admin reset the password for ${record.displayName || target}`);
  res.json({ success: true });
});

// ── GET a day's schedule (live preview if nothing saved yet) ──
app.get('/api/schedule/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format, expected YYYY-MM-DD' });
  res.json({ success: true, date, rows: getOrBuildDayRows(date), saved: scheduleExists(date) });
});

// ── Toggle a single person's leave status for a date ──────────
app.post('/api/schedule/:date/leave', requireAuth, requireAdmin, (req, res) => {
  const { date } = req.params;
  const { rosterId, onLeave } = req.body;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });
  if (!rosterId) return res.status(400).json({ success: false, message: 'rosterId required' });

  let dayRows = getOrBuildDayRows(date).map(r => ({ id: r.id, name: r.name, region: r.region, onLeave: !!r.onLeave, shiftLabel: r.shiftLabel }));
  const idx = dayRows.findIndex(r => r.id === rosterId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Person not found in this day\'s schedule' });
  dayRows[idx].onLeave = !!onLeave;

  const roster = readRoster();
  const computed = computeSchedule(roster.cycleStart, dayRows);
  writeSchedule(date, computed);
  console.log(`[leave] ${date} — ${dayRows[idx].name} marked ${onLeave ? 'ON LEAVE' : 'available'}`);
  res.json({ success: true, date, rows: computed });
});

// ── Manual "Shift Timing" label override for a date ──
// Purely a display label the admin sets by hand (e.g. reassigning Manoj to
// the 05:00 slot when Arun is on leave). Completely independent of
// computeSchedule — never touches shiftSlot, ticketTimeWindow, or the
// day's actual order. Reorder/leave-toggle logic is untouched by this.
app.post('/api/schedule/:date/shift-label', requireAuth, requireAdmin, (req, res) => {
  const { date } = req.params;
  const { rosterId, shiftLabel } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });
  if (!rosterId) return res.status(400).json({ success: false, message: 'rosterId required' });

  const current = getOrBuildDayRows(date);
  const idx = current.findIndex(r => r.id === rosterId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Person not found in this day\'s schedule' });

  // empty string / falsy clears the override, falling back to the roster's nominal shift again
  if (shiftLabel) current[idx] = { ...current[idx], shiftLabel };
  else { const { shiftLabel: _drop, ...rest } = current[idx]; current[idx] = rest; }

  writeSchedule(date, current);
  console.log(`[shift-label] ${date} — ${current[idx].name} set to ${shiftLabel || '(cleared, back to default)'}`);
  res.json({ success: true, date, rows: current });
});

// ── Reorder a day's sequence (ad-hoc swap, doesn't touch the roster) ──
app.post('/api/schedule/:date/reorder', requireAuth, requireAdmin, (req, res) => {
  const { date } = req.params;
  const { order } = req.body; // array of rosterIds in the new order
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });
  if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order must be an array of ids' });

  const current = getOrBuildDayRows(date);
  const byId = {};
  current.forEach(r => { byId[r.id] = { id: r.id, name: r.name, region: r.region, onLeave: !!r.onLeave, shiftLabel: r.shiftLabel }; });
  const reordered = order.map(id => byId[id]).filter(Boolean);
  // append anything missing from the given order (safety net)
  current.forEach(r => { if (!order.includes(r.id)) reordered.push(byId[r.id]); });

  const roster = readRoster();
  const computed = computeSchedule(roster.cycleStart, reordered);
  writeSchedule(date, computed);
  res.json({ success: true, date, rows: computed });
});

// ── Regenerate a day fresh from the master roster ─────────────
app.post('/api/schedule/:date/regenerate', requireAuth, requireAdmin, (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });
  const roster = readRoster();
  const computed = computeSchedule(roster.cycleStart, defaultDaySequence());
  writeSchedule(date, computed);
  console.log(`[regenerate] ${date} reset to master roster (${computed.length} people, nobody on leave)`);
  res.json({ success: true, date, rows: computed });
});

// ── Master roster CRUD ─────────────────────────────────────────
app.get('/api/master-roster', requireAuth, (req, res) => {
  res.json({ success: true, ...readRoster() });
});

app.put('/api/master-roster', requireAuth, requireAdmin, (req, res) => {
  const { cycleStart, people } = req.body;
  if (!Array.isArray(people)) return res.status(400).json({ success: false, message: 'people must be an array' });
  const cleanPeople = people.map(p => ({
    id:     p.id && String(p.id).trim() ? String(p.id).trim() : genId(),
    name:   String(p.name || '').trim(),
    region: String(p.region || '').trim()
  })).filter(p => p.name);
  const roster = {
    cycleStart: /^\d{1,2}:\d{2}$/.test(cycleStart) ? cycleStart : '05:00',
    people: cleanPeople
  };
  writeRoster(roster);
  console.log(`[master-roster] Saved — ${cleanPeople.length} people, cycle start ${roster.cycleStart}`);
  res.json({ success: true, ...roster });
});

// ── Import master roster from Excel/CSV (Name + Region columns) ─
app.post('/api/master-roster/import', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: false });
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Could not read this file. Use .xlsx, .xls, or .csv.' });
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
  if (sheet.length === 0) return res.status(400).json({ success: false, message: 'No rows found in the sheet.' });

  function pick(rowObj, keys) {
    const lower = {};
    Object.keys(rowObj).forEach(k => { lower[k.trim().toLowerCase()] = rowObj[k]; });
    for (const k of keys) { if (lower[k] && String(lower[k]).trim()) return String(lower[k]).trim(); }
    return '';
  }

  const people = [];
  let skipped = 0;
  sheet.forEach(r => {
    const name = pick(r, ['name']);
    if (!name) { skipped++; return; }
    people.push({ id: genId(), name, region: pick(r, ['region']) });
  });

  const roster = readRoster();
  roster.people = people;
  writeRoster(roster);
  console.log(`[master-roster] Imported ${people.length} people from ${req.file.originalname}`);
  res.json({ success: true, cycleStart: roster.cycleStart, people, skipped });
});

// ── SMB Chat Assignment Live Tracker — routes ──────────────────
// Roster: who's EBS (assigns chats), who's SMB (receives them)
app.get('/api/tracker/roster', requireAuth, (req, res) => {
  const roster = readTrackerRoster();
  // Always display in the same order ZIA SLOT currently uses — if an
  // admin reorders the master roster there, this follows automatically
  // instead of drifting out of sync with a separately-ordered file.
  const masterOrder = readRoster().people.map(p => p.id);
  roster.people = [...roster.people].sort((a, b) => {
    const ia = masterOrder.indexOf(a.id), ib = masterOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  if (req.session.role === 'admin') {
    const users = readUsers();
    const byEbsId = {};
    Object.values(users).forEach(u => { if (u.role === 'ebs' && u.ebsId) byEbsId[u.ebsId] = u.username; });
    roster.people = roster.people.map(p => p.mode === 'EBS' ? { ...p, username: byEbsId[p.id] || null } : p);
  }
  res.json({ success: true, ...roster });
});

app.put('/api/tracker/roster', requireAuth, requireAdmin, (req, res) => {
  const { people } = req.body;
  if (!Array.isArray(people)) return res.status(400).json({ success: false, message: 'people must be an array' });
  const cleanPeople = people.map(p => ({
    id:     p.id && String(p.id).trim() ? String(p.id).trim() : genId(),
    name:   String(p.name || '').trim(),
    region: String(p.region || '').trim(),
    mode:   String(p.mode || '').trim().toUpperCase() === 'EBS' ? 'EBS' : 'SMB'
  })).filter(p => p.name);
  writeTrackerRoster({ people: cleanPeople });
  console.log(`[tracker] Roster saved — ${cleanPeople.length} people`);
  res.json({ success: true, people: cleanPeople });
});

// Get a day's assignment events + computed counts (live tracker view)
app.get('/api/tracker/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format, expected YYYY-MM-DD' });
  res.json({ success: true, date, ...summarizeTrackerDay(readTrackerDay(date)) });
});

// Click "+" on an SMB tech — logs which EBS tech assigned them a chat
app.post('/api/tracker/:date/assign', requireAuth, requireAssignAccess, (req, res) => {
  const { date } = req.params;
  const { smbId } = req.body || {};
  const comment = String(req.body.comment || '').trim().slice(0, 500);
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });

  // An EBS-role account can only ever log a chat under their OWN linked
  // identity — the client-sent ebsId is ignored for that role, so a
  // tampered request still can't impersonate another EBS tech. Only
  // Admin may specify a different ebsId (e.g. logging on someone's behalf).
  let ebsId = req.body.ebsId;
  if (req.session.role === 'ebs') {
    const users = readUsers();
    const me = users[req.session.username];
    ebsId = me && me.ebsId;
  }
  if (!ebsId || !smbId) return res.status(400).json({ success: false, message: 'ebsId and smbId are required' });

  const roster = readTrackerRoster();
  const ebsPerson = roster.people.find(p => p.id === ebsId);
  const smbPerson = roster.people.find(p => p.id === smbId);
  if (!ebsPerson) return res.status(404).json({ success: false, message: 'EBS tech not found. Refresh and try again.' });
  if (!smbPerson) return res.status(404).json({ success: false, message: 'SMB tech not found. Refresh and try again.' });

  const day = readTrackerDay(date);
  day.events = day.events || [];

  // Past 2 chats to the SAME SMB tech from the SAME EBS tech today, a
  // reason is required — cheap guardrail against silently dumping load
  // on one person without a note explaining why.
  const priorFromMeToThem = day.events.filter(e => e.ebsId === ebsId && e.smbId === smbId).length;
  if (priorFromMeToThem >= 2 && !comment) {
    return res.status(400).json({
      success: false,
      message: `You've already assigned ${priorFromMeToThem} chats to ${smbPerson.name} today — please add a note for this one.`,
      requiresComment: true
    });
  }

  day.events.push({
    id: genEventId(),
    ts: new Date().toISOString(),
    ebsId: ebsPerson.id, ebsName: ebsPerson.name,
    smbId: smbPerson.id, smbName: smbPerson.name,
    comment: comment || null
  });
  writeTrackerDay(date, day);
  console.log(`[tracker] ${date} — ${ebsPerson.name} assigned a chat to ${smbPerson.name}${comment ? ` — "${comment}"` : ''}`);
  res.json({ success: true, date, ...summarizeTrackerDay(day) });
});

// Self-service correction — removes the caller's own most recent
// assignment TO THIS SPECIFIC SMB TECH (not a global undo). An EBS tech
// can only ever remove their own click on the card they clicked, never
// anyone else's, and never a different SMB tech's count. No admin
// needed for this everyday mis-click case.
app.post('/api/tracker/:date/unassign', requireAuth, requireAssignAccess, (req, res) => {
  const { date } = req.params;
  const { smbId } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });

  let ebsId = req.body.ebsId;
  if (req.session.role === 'ebs') {
    const users = readUsers();
    const me = users[req.session.username];
    ebsId = me && me.ebsId;
  }
  if (!ebsId || !smbId) return res.status(400).json({ success: false, message: 'ebsId and smbId are required' });

  const day = readTrackerDay(date);
  day.events = day.events || [];
  let idx = -1;
  for (let i = day.events.length - 1; i >= 0; i--) {
    if (day.events[i].ebsId === ebsId && day.events[i].smbId === smbId) { idx = i; break; }
  }
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "No assignment of yours to this person today — nothing to undo." });
  }
  const removed = day.events.splice(idx, 1)[0];
  writeTrackerDay(date, day);
  console.log(`[tracker] ${date} — ${removed.ebsName} undid their own assignment to ${removed.smbName}`);
  res.json({ success: true, date, ...summarizeTrackerDay(day) });
});

// Undo the most recent assignment for the day (mis-click correction)
app.post('/api/tracker/:date/undo', requireAuth, requireAdmin, (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });
  const day = readTrackerDay(date);
  const removed = (day.events || []).pop();
  writeTrackerDay(date, day);
  console.log(`[tracker] ${date} — undo${removed ? ` (${removed.ebsName} → ${removed.smbName})` : ' (nothing to undo)'}`);
  res.json({ success: true, date, ...summarizeTrackerDay(day) });
});

// Reset a day's counts back to zero
app.post('/api/tracker/:date/reset', requireAuth, requireAdmin, (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format' });
  writeTrackerDay(date, { events: [] });
  console.log(`[tracker] ${date} — reset to zero`);
  res.json({ success: true, date, ...summarizeTrackerDay({ events: [] }) });
});

// ── Leave-tech export helpers ──────────────────────────────────
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(fields) { return fields.map(csvEscape).join(',') + '\r\n'; }
function daysInMonthISO(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]); // 1-12
  const count = new Date(year, month, 0).getDate();
  const out = [];
  for (let d = 1; d <= count; d++) out.push(`${m[1]}-${m[2]}-${String(d).padStart(2, '0')}`);
  return out;
}
function formatDisplayDateForCSV(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Export on-leave tech details for a single day (CSV) ────────
app.get('/api/export/leave/day/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  if (!isValidDate(date)) return res.status(400).json({ success: false, message: 'Invalid date format, expected YYYY-MM-DD' });

  const rows = getOrBuildDayRows(date).filter(r => r.onLeave);
  let csv = csvRow(['Date', 'Name', 'Region']);
  rows.forEach(r => { csv += csvRow([formatDisplayDateForCSV(date), r.name, r.region]); });
  if (rows.length === 0) csv += csvRow([formatDisplayDateForCSV(date), 'No one on leave', '']);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leave-${date}.csv"`);
  res.send(csv);
});

// ── Export on-leave tech details for a whole month (CSV) ───────
app.get('/api/export/leave/month/:month', requireAuth, (req, res) => {
  const { month } = req.params; // YYYY-MM
  const dates = daysInMonthISO(month);
  if (!dates) return res.status(400).json({ success: false, message: 'Invalid month format, expected YYYY-MM' });

  let csv = csvRow(['Date', 'Name', 'Region']);
  let total = 0;
  dates.forEach(date => {
    const rows = getOrBuildDayRows(date).filter(r => r.onLeave);
    rows.forEach(r => { csv += csvRow([formatDisplayDateForCSV(date), r.name, r.region]); total++; });
  });
  if (total === 0) csv += csvRow(['—', 'No one on leave this month', '']);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leave-${month}.csv"`);
  res.send(csv);
});

// ── List which dates have a saved schedule (for calendar dots) ─
app.get('/api/dates-with-data', requireAuth, (req, res) => {
  try {
    const dates = db.listDatesWithPrefix('schedule:');
    res.json({ success: true, dates: dates.sort() });
  } catch (e) {
    res.json({ success: true, dates: [] });
  }
});

// ── Auto-generate today at midnight (also runs once at startup) ─
let lastAutoFillDate = null;
function runAutoFill() {
  const today = istTodayISO();
  if (today === lastAutoFillDate) return;
  lastAutoFillDate = today;
  if (scheduleExists(today)) {
    console.log(`[auto-fill] ${today} already has a saved schedule — skipped.`);
    return;
  }
  const roster = readRoster();
  const computed = computeSchedule(roster.cycleStart, defaultDaySequence());
  writeSchedule(today, computed);
  console.log(`[auto-fill] ${today} generated from master roster — ${computed.length} people, nobody on leave by default.`);
}

// ── Morning digest ──────────────────────────────────────────
let lastReminderDate = null;
async function runReminderCheck() {
  if (!REMINDER_CONFIG.enabled) return;
  const today = istTodayISO();
  if (today === lastReminderDate) return;
  if (istNowHHMM() < REMINDER_CONFIG.time) return;
  lastReminderDate = today;

  const rows = getOrBuildDayRows(today);
  const onLeave = rows.filter(r => r.onLeave).length;
  const message = `📋 Today's shift roster is ready — ${rows.length - onLeave} scheduled, ${onLeave} on leave. View: ${REMINDER_CONFIG.toolUrl}`;

  if (!REMINDER_CONFIG.webhookUrl) {
    console.log(`[digest] ${message} (no REMINDER_WEBHOOK_URL configured — not sent anywhere)`);
    return;
  }
  try {
    await fetch(REMINDER_CONFIG.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message })
    });
    console.log('[digest] Sent.');
  } catch (e) {
    console.error('[digest] Failed to send webhook:', e.message);
  }
}

// ── Start server ────────────────────────────────────────────
(async function main() {
  await db.init();
  seedAll();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║           Shift Roster — EC Support          ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Local:   http://localhost:${PORT}               ║`);
    console.log(`║  Network: http://<your-ip>:${PORT}               ║`);
    console.log(`║  Storage: ${db.USE_MONGO ? 'MongoDB Atlas' : './data/*.json (local files)'}`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Auto-generate today's schedule: enabled (checks every 2 min)`);
    console.log(`  Morning digest: ${REMINDER_CONFIG.enabled ? (REMINDER_CONFIG.webhookUrl ? 'enabled at ' + REMINDER_CONFIG.time + ' IST' : 'enabled but no webhook URL set — see REMINDER_CONFIG') : 'disabled'}`);
    console.log('');
    console.log('  Press Ctrl + C to stop the server');
    console.log('');
  });

  setInterval(() => { runAutoFill(); runReminderCheck(); }, 2 * 60 * 1000);
  runAutoFill();
  runReminderCheck();
})();
