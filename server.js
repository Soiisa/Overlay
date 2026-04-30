const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

// --- CONFIGURATION ---
const HENRIK_API_KEY = process.env.HENRIK_API_KEY || "YOUR_API_KEY_HERE"; 
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000; // Force refresh if data is older than 2 mins
// ---------------------

const app = express();
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 5 * 60 * 1000; 

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir); }

const db = new Database(path.join(dataDir, 'valorant_tracker.db'));

// Database Schema
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

const insertUser = db.prepare('INSERT OR IGNORE INTO tracked_users (name, tag, region) VALUES (?, ?, ?)');
const updateUserTimestamp = db.prepare('UPDATE tracked_users SET last_updated = ? WHERE name = ? AND tag = ? AND region = ?');
const getUserInfo = db.prepare('SELECT * FROM tracked_users WHERE name = ? AND tag = ? AND region = ?');

const insertMatch = db.prepare(`
  INSERT OR IGNORE INTO matches 
  (match_id, name, tag, region, map, agent, kills, deaths, assists, headshots, bodyshots, legshots, result, rounds_won, rounds_lost, rank, timestamp) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getAllTrackedUsers = db.prepare('SELECT * FROM tracked_users');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

async function fetchAndSaveMatches(region, name, tag) {
    try {
        console.log(`[API] Fetching fresh matches for ${name}#${tag}...`);
        const encodedName = encodeURIComponent(name);
        const encodedTag = encodeURIComponent(tag);
        
        const response = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodedName}/${encodedTag}?mode=competitive&size=10`, {
            headers: { 'Authorization': HENRIK_API_KEY }
        });
        
        if (response.data && response.data.data) {
            const matches = response.data.data;
            let addedCount = 0;

            for (const match of matches) {
                // Find the player in the list (handle case insensitivity)
                const playerStat = match.players.all_players.find(
                    p => p.name.toLowerCase() === name.toLowerCase() && p.tag.toLowerCase() === tag.toLowerCase()
                );

                if (!playerStat) continue;

                const playerTeam = playerStat.team?.toLowerCase();
                if (!playerTeam || !match.teams || !match.teams[playerTeam]) continue; 

                const teamData = match.teams[playerTeam];
                let result = 'Draw';
                if (teamData.has_won) result = 'Victory';
                else if (teamData.rounds_won < teamData.rounds_lost) result = 'Defeat';

                const info = insertMatch.run(
                    match.metadata.matchid,
                    name.toLowerCase(),
                    tag.toLowerCase(),
                    region.toLowerCase(),
                    match.metadata.map,
                    playerStat.character,
                    playerStat.stats.kills,
                    playerStat.stats.deaths,
                    playerStat.stats.assists,
                    playerStat.stats.headshots,
                    playerStat.stats.bodyshots,
                    playerStat.stats.legshots,
                    result,
                    teamData.rounds_won,
                    teamData.rounds_lost,
                    playerStat.currenttier_patched || 'Unranked',
                    match.metadata.game_start
                );
                
                if (info.changes > 0) addedCount++;
            }
            // Mark the user as updated
            updateUserTimestamp.run(Date.now(), name.toLowerCase(), tag.toLowerCase(), region.toLowerCase());
            console.log(`[DB] Sync complete. ${addedCount} new matches found.`);
            return true;
        }
    } catch (error) {
        console.error(`[Error] API Fetch failed: ${error.message}`);
        return false;
    }
}

// Background Poller
setInterval(async () => {
    const users = getAllTrackedUsers.all();
    for (const user of users) {
        await fetchAndSaveMatches(user.region, user.name, user.tag);
        await new Promise(r => setTimeout(r, 2000)); 
    }
}, POLLING_INTERVAL_MS);

app.get('/api/stats', async (req, res) => {
    const { name, tag, region, date } = req.query;
    if (!name || !tag || !region) return res.status(400).json({ error: 'Missing params' });

    const lowerName = name.toLowerCase();
    const lowerTag = tag.toLowerCase();
    const lowerRegion = region.toLowerCase();

    // Ensure user exists in tracking table
    insertUser.run(lowerName, lowerTag, lowerRegion);
    
    // PRO-ACTIVE REFRESH LOGIC
    const userInfo = getUserInfo.get(lowerName, lowerTag, lowerRegion);
    const timeSinceUpdate = Date.now() - (userInfo?.last_updated || 0);

    if (timeSinceUpdate > REFRESH_THRESHOLD_MS) {
        console.log(`[System] Data for ${lowerName} is stale (${Math.round(timeSinceUpdate/1000)}s old). Forcing refresh...`);
        await fetchAndSaveMatches(lowerRegion, lowerName, lowerTag);
    }

    let matches;
    if (date) {
        const startTime = Math.floor(new Date(date + "T00:00:00").getTime() / 1000);
        matches = db.prepare(`
            SELECT * FROM matches 
            WHERE name = ? AND tag = ? AND region = ? AND timestamp >= ? 
            ORDER BY timestamp DESC LIMIT 15
        `).all(lowerName, lowerTag, lowerRegion, startTime);
    } else {
        matches = db.prepare(`
            SELECT * FROM matches 
            WHERE name = ? AND tag = ? AND region = ? 
            ORDER BY timestamp DESC LIMIT 10
        `).all(lowerName, lowerTag, lowerRegion);
    }

    res.json({ matches });
});

app.get('/api/message', (req, res) => res.json({ message: "" }));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
