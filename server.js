const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

// --- CONFIGURATION ---
const HENRIK_API_KEY = process.env.HENRIK_API_KEY || "YOUR_API_KEY_HERE"; 
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000; // Auto-fetch if data is older than 2 mins
const PORT = process.env.PORT || 3000;

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir); }
const db = new Database(path.join(dataDir, 'valorant_tracker.db'));

// Tables initialization
db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_users (
    name TEXT,
    tag TEXT,
    region TEXT,
    last_updated INTEGER DEFAULT 0,
    PRIMARY KEY(name, tag, region)
  );

  CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    name TEXT,
    tag TEXT,
    region TEXT,
    map TEXT,
    agent TEXT,
    kills INTEGER,
    deaths INTEGER,
    assists INTEGER,
    headshots INTEGER,
    bodyshots INTEGER,
    legshots INTEGER,
    result TEXT,
    rounds_won INTEGER,
    rounds_lost INTEGER,
    rank TEXT,
    timestamp INTEGER
  );
`);

// Migration: Check for last_updated column
try {
    db.prepare("ALTER TABLE tracked_users ADD COLUMN last_updated INTEGER DEFAULT 0").run();
    console.log("[DB] Migration: Added last_updated column.");
} catch (e) { /* Column already exists */ }

// Database Prepared Statements
const insertUser = db.prepare('INSERT OR IGNORE INTO tracked_users (name, tag, region) VALUES (?, ?, ?)');
const updateUserTimestamp = db.prepare('UPDATE tracked_users SET last_updated = ? WHERE name = ? AND tag = ? AND region = ?');
const getUserInfo = db.prepare('SELECT * FROM tracked_users WHERE name = ? AND tag = ? AND region = ?');
const insertMatch = db.prepare(`
  INSERT OR IGNORE INTO matches 
  (match_id, name, tag, region, map, agent, kills, deaths, assists, headshots, bodyshots, legshots, result, rounds_won, rounds_lost, rank, timestamp) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// API Fetch Logic
async function syncMatches(region, name, tag) {
    try {
        console.log(`[API] Fetching latest for ${name}#${tag}...`);
        const url = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?mode=competitive&size=10`;
        const response = await axios.get(url, { headers: { 'Authorization': HENRIK_API_KEY } });
        
        if (response.data && response.data.data) {
            for (const m of response.data.data) {
                const p = m.players.all_players.find(x => x.name.toLowerCase() === name.toLowerCase());
                if (!p) continue;

                const team = p.team.toLowerCase();
                const teamData = m.teams[team];
                const result = teamData.has_won ? 'Victory' : (teamData.rounds_won === teamData.rounds_lost ? 'Draw' : 'Defeat');

                insertMatch.run(
                    m.metadata.matchid, name.toLowerCase(), tag.toLowerCase(), region.toLowerCase(),
                    m.metadata.map, p.character, p.stats.kills, p.stats.deaths, p.stats.assists,
                    p.stats.headshots, p.stats.bodyshots, p.stats.legshots,
                    result, teamData.rounds_won, teamData.rounds_lost,
                    p.currenttier_patched || 'Unranked', m.metadata.game_start
                );
            }
            updateUserTimestamp.run(Date.now(), name.toLowerCase(), tag.toLowerCase(), region.toLowerCase());
            return true;
        }
    } catch (err) {
        console.error(`[Error] Sync failed for ${name}:`, err.message);
        return false;
    }
}

// Routes
app.get('/api/stats', async (req, res) => {
    const { region, name, tag, date } = req.query;
    if (!region || !name || !tag) return res.status(400).json({ error: "Missing params" });

    const lName = name.toLowerCase();
    const lTag = tag.toLowerCase();
    const lRegion = region.toLowerCase();

    insertUser.run(lName, lTag, lRegion);
    const user = getUserInfo.get(lName, lTag, lRegion);

    // If data is older than threshold, sync now
    if (Date.now() - (user?.last_updated || 0) > REFRESH_THRESHOLD_MS) {
        await syncMatches(lRegion, lName, lTag);
    }

    let sql = `SELECT * FROM matches WHERE name = ? AND tag = ? AND region = ?`;
    let params = [lName, lTag, lRegion];

    if (date) {
        const startTimestamp = Math.floor(new Date(date + "T00:00:00").getTime() / 1000);
        sql += ` AND timestamp >= ?`;
        params.push(startTimestamp);
    }

    const matches = db.prepare(sql + ` ORDER BY timestamp DESC LIMIT 15`).all(...params);
    res.json({ matches });
});

app.get('/api/message', (req, res) => res.json({ message: "" }));

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
