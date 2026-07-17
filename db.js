// db.js — Storage abstraction for ZIASHIFT
//
// Local (Windows/pm2): MONGODB_URI is not set → every call below reads and
// writes the exact same files, in the exact same locations, that the app
// has always used. Local behavior is 100% unchanged.
//
// Cloud (Render): MONGODB_URI is set as an environment variable there →
// all data is stored in MongoDB Atlas instead, in a single "kv" collection
// (one document per logical key: roster, users, trackerRoster,
// schedule:YYYY-MM-DD, tracker:YYYY-MM-DD). An in-memory cache is loaded
// once at startup so every route in server.js can keep calling these
// functions synchronously, same as before — writes update the cache
// immediately and are persisted to Mongo in the background, in order.

const fs   = require('fs');
const path = require('path');

const USE_MONGO = !!process.env.MONGODB_URI;
const DATA_DIR  = path.join(__dirname, 'data');

let cache      = new Map();
let collection = null;
let writeQueue = Promise.resolve();

async function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!USE_MONGO) {
    console.log('[db] MONGODB_URI not set — using local JSON file storage (unchanged local behavior).');
    return;
  }

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const dbName = process.env.MONGODB_DBNAME || 'ziashift';
  const db = client.db(dbName);
  collection = db.collection('kv');
  await collection.createIndex({ _id: 1 });

  const docs = await collection.find({}).toArray();
  docs.forEach(d => cache.set(d._id, d.data));
  console.log(`[db] Connected to MongoDB Atlas ("${dbName}") — loaded ${docs.length} record(s) into memory.`);
}

// ── File-mode key → path mapping (identical to the app's original layout) ─
function keyToFilePath(key) {
  if (key === 'roster')        return path.join(DATA_DIR, 'master-roster.json');
  if (key === 'users')         return path.join(DATA_DIR, 'users.json');
  if (key === 'trackerRoster') return path.join(DATA_DIR, 'tracker-roster.json');
  if (key === 'announcement')  return path.join(DATA_DIR, 'announcement.json');
  if (key.startsWith('schedule:')) return path.join(DATA_DIR, 'schedules', `${key.slice(9)}.json`);
  if (key.startsWith('tracker:'))  return path.join(DATA_DIR, 'tracker', `${key.slice(8)}.json`);
  throw new Error(`[db] Unknown key: ${key}`);
}
function ensureDirFor(fp) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Public API ──────────────────────────────────────────────────────────
function has(key) {
  if (!USE_MONGO) return fs.existsSync(keyToFilePath(key));
  return cache.has(key);
}

function get(key, fallback = null) {
  if (!USE_MONGO) {
    const fp = keyToFilePath(key);
    if (!fs.existsSync(fp)) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8') || 'null');
      return parsed === null ? fallback : parsed;
    } catch (e) { return fallback; }
  }
  return cache.has(key) ? cache.get(key) : fallback;
}

function set(key, value) {
  if (!USE_MONGO) {
    const fp = keyToFilePath(key);
    ensureDirFor(fp);
    fs.writeFileSync(fp, JSON.stringify(value, null, 2), 'utf8');
    return;
  }
  cache.set(key, value);
  writeQueue = writeQueue
    .then(() => collection.updateOne({ _id: key }, { $set: { data: value } }, { upsert: true }))
    .catch(err => console.error(`[db] Mongo write failed for "${key}":`, err.message));
}

function del(key) {
  if (!USE_MONGO) {
    const fp = keyToFilePath(key);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return;
  }
  cache.delete(key);
  writeQueue = writeQueue
    .then(() => collection.deleteOne({ _id: key }))
    .catch(err => console.error(`[db] Mongo delete failed for "${key}":`, err.message));
}

// Returns the date suffixes (YYYY-MM-DD) of every key stored under a given
// prefix, e.g. listDatesWithPrefix('schedule:') for the calendar dots.
function listDatesWithPrefix(prefix) {
  if (!USE_MONGO) {
    const dir = prefix === 'schedule:' ? path.join(DATA_DIR, 'schedules') : path.join(DATA_DIR, 'tracker');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  }
  const out = [];
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

module.exports = { init, has, get, set, del, listDatesWithPrefix, USE_MONGO };
