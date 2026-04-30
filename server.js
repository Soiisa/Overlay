const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 5 * 60 * 1000; 

// Support multiple keys for round-robin rate limiting
const HENRIK_KEYS = [
    process.env.HENRIK_API_KEY, 
    process.env.HENRIK_API_KEY_2
].filter(Boolean);

if (HENRIK_KEYS.length === 0) {
    console.warn("⚠️ No HENRIK_API_KEY set!");
}
// ---------------------

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE SETUP ---
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const db = new Database(path.join(dataDir, 'valorant_tracker.db'));

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
    score INTEGER,
    rank TEXT,
    timestamp INTEGER
  );
`);

const insertUser = db.prepare('INSERT OR IGNORE INTO tracked_users (name, tag, region) VALUES (?, ?, ?)');
const updateUserTimestamp = db.prepare('UPDATE tracked_users SET last_updated = ? WHERE name = ? AND tag = ? AND region = ?');
const getUserInfo = db.prepare('SELECT * FROM tracked_users WHERE name = ? AND tag = ? AND region = ?');
const getAllTrackedUsers = db.prepare('SELECT * FROM tracked_users');
const insertMatch = db.prepare(`
  INSERT OR IGNORE INTO matches 
  (match_id, name, tag, region, map, agent, kills, deaths, assists, headshots, bodyshots, legshots, result, score, rank, timestamp) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// --- YOUR RATE-LIMIT / ROUND-ROBIN LOGIC ---
const keyStates = HENRIK_KEYS.map((k) => ({ key: k, lastCallAt: 0 }));
const CALLS_PER_MINUTE = 30;
const MIN_INTERVAL_MS = Math.ceil(60000 / CALLS_PER_MINUTE);
let nextKeyIndex = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pickNextKeyIndex() {
    if (keyStates.length === 0) return -1;
    const idx = nextKeyIndex % keyStates.length;
    nextKeyIndex = (nextKeyIndex + 1) % keyStates.length;
    return idx;
}

async function fetchWithHenrik(url, opts = {}, maxRetries = 4) {
    if (keyStates.length === 0) return fetch(url, opts);

    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
        attempt++;
        const keyIndex = pickNextKeyIndex();
        const state = keyStates[keyIndex];

        const now = Date.now();
        const timeSince = now - (state.lastCallAt || 0);
        if (timeSince < MIN_INTERVAL_MS) {
            await sleep(MIN_INTERVAL_MS - timeSince);
        }
        state.lastCallAt = Date.now();

        const headers = Object.assign({}, opts.headers || {}, state.key ? { Authorization: state.key } : {});
        const fetchOpts = Object.assign({}, opts, { headers });

        try {
            const resp = await fetch(url, fetchOpts);
            if (resp.status === 429) {
                lastError = new Error(`429 from Henrik (attempt ${attempt})`);
                const otherKeyAvailable = keyStates.some((_, i) => i !== keyIndex);
                if (otherKeyAvailable) {
                    await sleep(100 * attempt);
                    continue;
                } else {
                    await sleep(500 * Math.pow(2, attempt - 1));
                    continue;
                }
            }
            return resp;
        } catch (err) {
            lastError = err;
            await sleep(300 * Math.pow(2, attempt - 1));
            continue;
        }
    }
    throw lastError ?? new Error("fetchWithHenrik failed");
}

// --- YOUR ROBUST PARSING LOGIC ---
function determinePlayerTeam(match, playerStats) {
    const teamFromStats = playerStats?.team ?? playerStats?.player_team ?? null;
    if (teamFromStats) return String(teamFromStats).toLowerCase();
    return null;
}

function computeResultForTeam(match, teamKey) {
    if (!teamKey || !match?.teams) return 'Draw';
    const teamInfo = match.teams[teamKey];
    const otherKey = teamKey === "red" ? "blue" : "red";
    const otherInfo = match.teams[otherKey];

    if (typeof teamInfo?.has_won === "boolean") return teamInfo.has_won ? "Victory" : "Defeat";
    
    const r1 = Number(teamInfo?.rounds_won ?? NaN);
    const r2 = Number(otherInfo?.rounds_won ?? NaN);
    if (!Number.isNaN(r1) && !Number.isNaN(r2)) {
        if (r1 > r2) return "Victory";
        if (r1 < r2) return "Defeat";
    }
    return 'Draw';
}

// --- SYNC FUNCTION ---
async function syncMatches(region, name, tag) {
    try {
        console.log(`[API] Fetching ${name}#${tag}...`);
        const url = `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=10&mode=competitive`;
        
        const response = await fetchWithHenrik(url);
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        
        const payload = await response.json();
        const matches = Array.isArray(payload?.data) ? payload.data : [];
        let added = 0;

        for (const match of matches) {
            const allPlayers = Array.isArray(match.players?.all_players) ? match.players.all_players : [];
            const pStats = allPlayers.find(p => p.name?.toLowerCase() === name.toLowerCase() && p.tag?.toLowerCase() === tag.toLowerCase());
            
            if (!pStats) continue;

            const teamKey = determinePlayerTeam(match, pStats);
            const resultValue = computeResultForTeam(match, teamKey);
            const score = Number(pStats?.stats?.score ?? 0);

            const info = insertMatch.run(
                match.metadata.matchid, name.toLowerCase(), tag.toLowerCase(), region.toLowerCase(),
                match.metadata.map, pStats.character, 
                Number(pStats.stats?.kills ?? 0), Number(pStats.stats?.deaths ?? 0), Number(pStats.stats?.assists ?? 0),
                Number(pStats.stats?.headshots ?? 0), Number(pStats.stats?.bodyshots ?? 0), Number(pStats.stats?.legshots ?? 0),
                resultValue, score, pStats.currenttier_patched || 'Unranked', match.metadata.game_start
            );
            if(info.changes > 0) added++;
        }
        updateUserTimestamp.run(Date.now(), name.toLowerCase(), tag.toLowerCase(), region.toLowerCase());
        console.log(`[DB] Inserted ${added} new matches for ${name}.`);
    } catch (err) {
        console.error(`[Error] Failed to sync ${name}:`, err.message);
    }
}

// --- API ENDPOINTS ---
app.get('/api/stats', async (req, res) => {
    const { region, name, tag, date } = req.query;
    if (!region || !name || !tag) return res.status(400).json({ error: "Missing params" });

    const lName = name.toLowerCase();
    const lTag = tag.toLowerCase();
    const lRegion = region.toLowerCase();

    insertUser.run(lName, lTag, lRegion);
    const user = getUserInfo.get(lName, lTag, lRegion);

    // Force refresh if data is older than 2 minutes
    if (Date.now() - (user?.last_updated || 0) > 2 * 60 * 1000) {
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

setInterval(async () => {
    const users = getAllTrackedUsers.all();
    for (const user of users) {
        await syncMatches(user.region, user.name, user.tag);
    }
}, POLLING_INTERVAL_MS);

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
