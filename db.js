// Mongo Atlas data layer — replaces local JSON file storage so data
// survives Render's free-tier sleep/restart cycles (which wipe local disk).
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('FATAL: MONGODB_URI environment variable is not set.');
  console.error('Set it in Render → your service → Environment.');
  process.exit(1);
}

const client = new MongoClient(uri);
let db;

async function connect() {
  await client.connect();
  db = client.db('ziashift'); // database name — created automatically on first write
  await db.collection('schedules').createIndex({ _id: 1 });
  await db.collection('tracker_days').createIndex({ _id: 1 });
  console.log('[db] Connected to MongoDB Atlas.');
}

// ── settings collection: one doc each for roster, users, tracker roster ──
async function getRoster() {
  const doc = await db.collection('settings').findOne({ _id: 'roster' });
  return doc ? { cycleStart: doc.cycleStart, people: doc.people } : { cycleStart: '05:00', people: [] };
}
async function setRoster(roster) {
  await db.collection('settings').updateOne(
    { _id: 'roster' },
    { $set: { cycleStart: roster.cycleStart, people: roster.people } },
    { upsert: true }
  );
}
async function rosterExists() {
  return !!(await db.collection('settings').findOne({ _id: 'roster' }));
}

async function getUsers() {
  const doc = await db.collection('settings').findOne({ _id: 'users' });
  return doc ? doc.users : {};
}
async function setUsers(users) {
  await db.collection('settings').updateOne(
    { _id: 'users' },
    { $set: { users } },
    { upsert: true }
  );
}
async function usersExist() {
  return !!(await db.collection('settings').findOne({ _id: 'users' }));
}

async function getTrackerRoster() {
  const doc = await db.collection('settings').findOne({ _id: 'trackerRoster' });
  return doc ? { people: doc.people } : { people: [] };
}
async function setTrackerRoster(roster) {
  await db.collection('settings').updateOne(
    { _id: 'trackerRoster' },
    { $set: { people: roster.people } },
    { upsert: true }
  );
}
async function trackerRosterExists() {
  return !!(await db.collection('settings').findOne({ _id: 'trackerRoster' }));
}

// ── schedules collection: one doc per date, _id = 'YYYY-MM-DD' ──
async function getSchedule(date) {
  const doc = await db.collection('schedules').findOne({ _id: date });
  return doc ? doc.rows : null;
}
async function setSchedule(date, rows) {
  await db.collection('schedules').updateOne(
    { _id: date },
    { $set: { rows } },
    { upsert: true }
  );
}
async function scheduleExists(date) {
  return !!(await db.collection('schedules').findOne({ _id: date }, { projection: { _id: 1 } }));
}
async function listScheduleDates() {
  const docs = await db.collection('schedules').find({}, { projection: { _id: 1 } }).toArray();
  return docs.map(d => d._id).sort();
}

// ── tracker_days collection: one doc per date, _id = 'YYYY-MM-DD' ──
async function getTrackerDay(date) {
  const doc = await db.collection('tracker_days').findOne({ _id: date });
  return doc ? { events: doc.events || [] } : { events: [] };
}
async function setTrackerDay(date, day) {
  await db.collection('tracker_days').updateOne(
    { _id: date },
    { $set: { events: day.events || [] } },
    { upsert: true }
  );
}

module.exports = {
  connect,
  getRoster, setRoster, rosterExists,
  getUsers, setUsers, usersExist,
  getTrackerRoster, setTrackerRoster, trackerRosterExists,
  getSchedule, setSchedule, scheduleExists, listScheduleDates,
  getTrackerDay, setTrackerDay
};
