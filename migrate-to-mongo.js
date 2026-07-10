// migrate-to-mongo.js
//
// ONE-TIME USE, run locally on your Windows machine (not on Render).
// Pushes your real, current local data (roster, users, schedules, tracker)
// into MongoDB Atlas so the cloud site starts with your real data instead
// of the blank/default seed data.
//
// Usage (from D:\ZIASHIFT, in PowerShell or cmd):
//   set MONGODB_URI=your-atlas-connection-string
//   node migrate-to-mongo.js
//
// This does NOT touch your local JSON files or your local server in any
// way — it only reads them and copies them up to Mongo.

const fs   = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('ERROR: Set MONGODB_URI first, e.g.:');
  console.error('  set MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/');
  process.exit(1);
}

const DATA_DIR  = path.join(__dirname, 'data');
const SCHED_DIR = path.join(DATA_DIR, 'schedules');
const TRACK_DIR = path.join(DATA_DIR, 'tracker');

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return null; }
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const dbName = process.env.MONGODB_DBNAME || 'ziashift';
  const db = client.db(dbName);
  const collection = db.collection('kv');
  await collection.createIndex({ _id: 1 });

  let count = 0;
  async function push(key, value) {
    if (value === null || value === undefined) return;
    await collection.updateOne({ _id: key }, { $set: { data: value } }, { upsert: true });
    count++;
    console.log(`  ✓ ${key}`);
  }

  console.log(`Migrating local data into MongoDB Atlas database "${dbName}"...`);

  await push('roster', readJSON(path.join(DATA_DIR, 'master-roster.json')));
  await push('users', readJSON(path.join(DATA_DIR, 'users.json')));
  await push('trackerRoster', readJSON(path.join(DATA_DIR, 'tracker-roster.json')));

  if (fs.existsSync(SCHED_DIR)) {
    for (const f of fs.readdirSync(SCHED_DIR).filter(f => f.endsWith('.json'))) {
      const date = f.replace('.json', '');
      await push(`schedule:${date}`, readJSON(path.join(SCHED_DIR, f)));
    }
  }

  if (fs.existsSync(TRACK_DIR)) {
    for (const f of fs.readdirSync(TRACK_DIR).filter(f => f.endsWith('.json'))) {
      const date = f.replace('.json', '');
      await push(`tracker:${date}`, readJSON(path.join(TRACK_DIR, f)));
    }
  }

  console.log(`\nDone — ${count} record(s) migrated to MongoDB Atlas.`);
  await client.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
