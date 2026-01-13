require('dotenv').config();
const express = require("express");
const { Pool } = require("pg");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 8080;

// PostgreSQL bilan bog'lanish
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Agar Railway ishlatilsa
});

// Jadvalni yaratish funksiyasi
async function createTableIfNotExists() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                name TEXT NOT NULL,
                score INT NOT NULL
            )
        `);
        console.log("Leaderboard jadvali mavjud yoki yaratildi ✅");
    } catch (err) {
        console.error("Jadval yaratishda xatolik:", err);
    }
}

// Telegram user avatari olish
async function getUserPhoto(userId) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getUserProfilePhotos?user_id=${userId}&limit=1`);
        const data = await res.json();
        if (!data.result.total_count) return null;

        const fileId = data.result.photos[0][0].file_id;
        const fileRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${fileId}`);
        const fileData = await fileRes.json();
        return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileData.result.file_path}`;
    } catch {
        return null;
    }
}

// Leaderboard endpoint
app.get('/leaderboard', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT user_id, username, name, score FROM leaderboard ORDER BY score DESC LIMIT 10`
        );

        const enriched = await Promise.all(
            rows.map(async r => ({
                user_id: r.user_id,
                username: r.username || null,
                name: r.name,
                score: r.score,
                photo: await getUserPhoto(r.user_id).catch(() => null)
            }))
        );

        res.json(enriched);
    } catch (e) {
        console.error("Leaderboard error:", e);
        res.status(500).json({ error: 'DB error' });
    }
});

// Server ishga tushishi
app.listen(PORT, async () => {
    console.log(`Server ${PORT} portda ishga tushdi`);
    await createTableIfNotExists();
});
