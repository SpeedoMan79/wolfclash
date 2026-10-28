const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Redis } = require('@upstash/redis');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Public folder se HTML/CSS automatic load karne ke liye
app.use(express.static(path.join(__dirname, 'public')));

// Upstash Redis Connection
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Initial Setup
async function initData() {
    try {
        const user = await redis.get('user_profile');
        if (!user) {
            await redis.set('user_profile', { username: "KhiladiBattle", coins: 20, deposit: 15, winnings: 5 });
        }
        const matches = await redis.get('tournaments');
        if (!matches) {
            await redis.set('tournaments', [
                { id: 101, title: "Top - 9 Prize 🏆 SOLO SURVIVAL #190888", time: "Today at 08:20 PM", map: "Bermuda", prizePool: 220, perKill: 10, entryFee: 11, totalSpots: 20, joinedSpots: 16 }
            ]);
        }
    } catch (err) {
        console.log("Redis Init Error:", err);
    }
}
initData();

// API: Get User Profile
app.get('/api/user', async (req, res) => {
    try {
        const user = await redis.get('user_profile');
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Tournaments
app.get('/api/tournaments', async (req, res) => {
    try {
        const tournaments = await redis.get('tournaments') || [];
        res.json(tournaments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Join Tournament
app.post('/api/join', async (req, res) => {
    try {
        const { tournamentId } = req.body;
        let user = await redis.get('user_profile');
        let tournaments = await redis.get('tournaments');

        const match = tournaments.find(t => t.id === tournamentId);
        if (!match) return res.status(404).json({ success: false, message: "Match nahi mila!" });
        if (user.coins < match.entryFee) return res.status(400).json({ success: false, message: "Balance kam hai!" });
        if (match.joinedSpots >= match.totalSpots) return res.status(400).json({ success: false, message: "Slots full hain!" });

        user.coins -= match.entryFee;
        match.joinedSpots += 1;

        await redis.set('user_profile', user);
        await redis.set('tournaments', tournaments);

        res.json({ success: true, message: "Successfully joined!", newBalance: user.coins, updatedSpots: match.joinedSpots });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Admin Create Tournament
app.post('/api/admin/create-tournament', async (req, res) => {
    try {
        const { title, time, map, prizePool, perKill, entryFee, totalSpots } = req.body;
        let tournaments = await redis.get('tournaments') || [];

        const newMatch = {
            id: Date.now(),
            title, time, map,
            prizePool: Number(prizePool),
            perKill: Number(perKill),
            entryFee: Number(entryFee),
            totalSpots: Number(totalSpots),
            joinedSpots: 0
        };

        tournaments.push(newMatch);
        await redis.set('tournaments', tournaments);

        res.json({ success: true, message: "Tournament created!", tournament: newMatch });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
