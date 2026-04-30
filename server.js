const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

// --- CONFIGURATION ---
// Use Environment Variables for Coolify, fallback to string for local testing
const HENRIK_API_KEY = process.env.HENRIK_API_KEY || "YOUR_API_KEY_HERE"; 
// ---------------------

const app = express();
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 5 * 60 * 1000; // Poll every 5 minutes

// --- PERSISTENT STORAGE SETUP ---
// Create a 'data' directory if it doesn't exist. 
// We will tell Coolify to keep this folder safe during restarts.
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

// Initialize SQLite Database inside the persistent folder
const db = new Database(path.join(dataDir, 'valorant_tracker.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_users (
    name TEXT,
    tag TEXT,
    region TEXT,
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
const insertMatch = db.prepare(`
  INSERT OR IGNORE INTO matches 
  (match_id, name, tag, region, map, agent, kills, deaths, assists, headshots, bodyshots, legshots, result, rounds_won, rounds_lost, rank, timestamp) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const getMatchesForUser = db.prepare('SELECT * FROM matches WHERE name = ? AND tag = ? AND region = ? ORDER BY timestamp DESC LIMIT 10');
const getAllTrackedUsers = db.prepare('SELECT * FROM tracked_users');

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Fetch matches from Henrik API and save to DB
async function fetchAndSaveMatches(region, name, tag) {
    try {
        console.log(`[API] Fetching matches for ${name}#${tag} (${region})...`);
        
        const encodedName = encodeURIComponent(name);
        const encodedTag = encodeURIComponent(tag);
        
        const response = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodedName}/${encodedTag}?mode=competitive&size=10`, {
            headers: {
                'Authorization': HENRIK_API_KEY
            }
        });
        
        if (response.data && response.data.data) {
            const matches = response.data.data;
            let addedCount = 0;

            for (const match of matches) {
                if (match.metadata.mode !== "Competitive") continue;

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
            console.log(`[DB] Saved ${addedCount} new matches for ${name}#${tag}`);
        }
    } catch (error) {
        console.error(`[Error] Failed to fetch data for ${name}#${tag}: ${error.message}`);
    }
}

// Background Polling Loop
setInterval(async () => {
    const users = getAllTrackedUsers.all();
    console.log(`[System] Running scheduled API poll for ${users.length} users...`);
    for (const user of users) {
        await fetchAndSaveMatches(user.region, user.name, user.tag);
        await new Promise(resolve => setTimeout(resolve, 2000)); 
    }
}, POLLING_INTERVAL_MS);

// API Endpoint: Match Stats
app.get('/api/stats', async (req, res) => {
    const { name, tag, region } = req.query;
    
    if (!name || !tag || !region) return res.status(400).json({ error: 'Missing parameters' });

    const lowerName = name.toLowerCase();
    const lowerTag = tag.toLowerCase();
    const lowerRegion = region.toLowerCase();

    insertUser.run(lowerName, lowerTag, lowerRegion);
    const recentMatches = getMatchesForUser.all(lowerName, lowerTag, lowerRegion);
    
    if (recentMatches.length === 0) {
        await fetchAndSaveMatches(lowerRegion, lowerName, lowerTag);
    }

    const finalMatches = getMatchesForUser.all(lowerName, lowerTag, lowerRegion);
    res.json({ matches: finalMatches });
});

// API Endpoint: Stream Message
app.get('/api/message', (req, res) => {
    res.json({ message: "" }); 
});

// API Endpoint: Raw Testing
app.get('/api/raw', async (req, res) => {
    const { name, tag, region } = req.query;
    if (!name || !tag || !region) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const response = await axios.get(`https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?mode=competitive&size=10`, {
            headers: { 'Authorization': HENRIK_API_KEY }
        });
        res.json(response.data); 
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// '0.0.0.0' tells Node to accept connections from outside the Docker container
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Database stored securely in /data folder`);
});
