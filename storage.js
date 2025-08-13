'use strict';
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'data.json');

let db = { users: {}, playerData: {} };
try {
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object') db = { users: {}, playerData: {}, ...parsed };
  }
} catch (e) {
  console.warn('storage: failed to load data.json, starting fresh');
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    } catch (e) {
      console.warn('storage: save failed:', e.message);
    } finally {
      saveTimer = null;
    }
  }, 200);
}

module.exports = {
  getUser(username) {
    return db.users[username] || null;
  },
  setUser(username, value) {
    db.users[username] = value;
    scheduleSave();
  },
  getPlayerData(username) {
    return db.playerData[username] || null;
  },
  setPlayerData(username, value) {
    db.playerData[username] = value;
    scheduleSave();
  },
  getAll() { return db; },
};
