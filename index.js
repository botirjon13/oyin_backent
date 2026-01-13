const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Railway PostgreSQL bazasiga ulanish
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Jadvalni yaratish (agar yo'q bo'lsa)
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS leaderboard (
                user_id TEXT PRIMARY KEY,
                name TEXT,
                score INTEGER
            )
        `);
        console.log("PostgreSQL jadvali tayyor!");
    } catch (err) {
        console.error("Baza yaratishda xato:", err);
    }
};
initDb();

// Ballarni saqlash
app.post('/save', async (req, res) => {
    const { name, score, userId } = req.body;
    try {
        await pool.query(`
            INSERT INTO leaderboard (user_id, name, score)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                score = GREATEST(leaderboard.score, EXCLUDED.score),
                name = EXCLUDED.name
        `, [userId.toString(), name, score]);
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server xatosi" });
    }
});

// Reytingni olish (Top 10)
app.get('/leaderboard', async (req, res) => {
    try {
        const result = await pool.query('SELECT name, score FROM leaderboard ORDER BY score DESC LIMIT 10');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server xatosi" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server port ${PORT} da ishga tushdi (2026 yangilanishi)`));
