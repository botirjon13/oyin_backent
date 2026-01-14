const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Настройка подключения к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Railway сам дает эту переменную
    ssl: {
        rejectUnauthorized: false // Обязательно для облачных БД (Railway, Render)
    }
});

// Инициализация таблицы (создастся сама, если её нет)
const initDB = async () => {
    const queryText = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            telegram_id BIGINT UNIQUE NOT NULL,
            username TEXT,
            score INTEGER DEFAULT 0,
            last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    await pool.query(queryText);
    console.log("База данных PostgreSQL готова.");
};
initDB();

// 1. Сохранение результата
app.post('/save', async (req, res) => {
    const { telegram_id, username, score } = req.body;

    if (!telegram_id) return res.status(400).json({ error: "ID missing" });

    try {
        // Логика: если юзер есть — обновляем рекорд, если нет — создаем
        const query = `
            INSERT INTO users (telegram_id, username, score)
            VALUES ($1, $2, $3)
            ON CONFLICT (telegram_id) 
            DO UPDATE SET 
                score = GREATEST(users.score, EXCLUDED.score),
                username = EXCLUDED.username,
                last_played = CURRENT_TIMESTAMP
            RETURNING score;
        `;
        const result = await pool.query(query, [telegram_id, username, score]);
        res.json({ status: "ok", highScore: result.rows[0].score });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "DB Error" });
    }
});

// 2. Топ-10 игроков
app.get('/leaderboard', async (req, res) => {
    try {
        const result = await pool.query('SELECT username, score FROM users ORDER BY score DESC LIMIT 10');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "DB Error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PostgreSQL Server running on port ${PORT}`));
