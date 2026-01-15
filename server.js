const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL ulanishi
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Bazani frontend ma'lumotlariga moslab yaratish
const initDB = async () => {
    try {
        const queryText = `
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username TEXT,
                avatar_url TEXT,
                score INTEGER DEFAULT 0,
                last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await pool.query(queryText);
        console.log("PostgreSQL bazasi va 'users' jadvali tayyor.");
    } catch (err) {
        console.error("Bazani yaratishda xato:", err);
    }
};
initDB();

// 1. Natijani saqlash (game.js dan keladigan nickname va avatar_url ni qabul qiladi)
app.post('/save', async (req, res) => {
    const { telegram_id, nickname, avatar_url, score } = req.body;

    // Telegram ID bo'sh yoki 0 bo'lsa tekshirish (0 ni ham qabul qiladi)
    if (telegram_id === undefined || telegram_id === null) {
        return res.status(400).json({ error: "ID topilmadi" });
    }

    try {
        const query = `
            INSERT INTO users (telegram_id, username, avatar_url, score)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                score = GREATEST(users.score, EXCLUDED.score),
                username = EXCLUDED.username,
                avatar_url = EXCLUDED.avatar_url,
                last_played = CURRENT_TIMESTAMP
            RETURNING score;
        `;
        const result = await pool.query(query, [telegram_id, nickname, avatar_url, score]);
        res.json({ status: "ok", highScore: result.rows[0].score });
    } catch (err) {
        console.error("Saqlashda xato:", err);
        res.status(500).json({ error: "DB Error" });
    }
});

// 2. Top-10 Reyting (index.html dagi loadLeaderboard uchun moslangan)
app.get('/leaderboard', async (req, res) => {
    try {
        // SQL da 'username'ni 'nickname' deb qaytaramiz, frontend tushunishi uchun
        const result = await pool.query(`
            SELECT username AS nickname, avatar_url, score 
            FROM users 
            ORDER BY score DESC 
            LIMIT 10
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Reytingda xato:", err);
        res.status(500).json({ error: "DB Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server 2026 versiyasi portda yondi: ${PORT}`));
