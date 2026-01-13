// index.js
require('dotenv').config(); // .env faylni o‘qiydi
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Pool } = require('pg'); // Postgres pool

const app = express();
app.use(cors());
app.use(express.json());

// Postgres Pool sozlamasi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Railway yoki Heroku uchun kerak bo'lishi mumkin
  },
});

// Telegram profil rasmini olish funksiyasi
async function getUserPhoto(userId) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getUserProfilePhotos?user_id=${userId}&limit=1`
    );
    const data = await res.json();
    if (!data.result.total_count) return null;

    const fileId = data.result.photos[0][0].file_id;

    const fileRes = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await fileRes.json();

    return `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileData.result.file_path}`;
  } catch (err) {
    console.error("getUserPhoto xatolik:", err);
    return null;
  }
}

// Ballarni saqlash
app.post('/save', async (req, res) => {
  const { telegram_id, username, score } = req.body;
  try {
    await pool.query(
      `INSERT INTO leaderboard(user_id, username, score)
       VALUES($1,$2,$3)
       ON CONFLICT (user_id)
       DO UPDATE SET score = GREATEST(leaderboard.score, EXCLUDED.score), username = EXCLUDED.username`,
      [telegram_id, username, score]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Save xatolik:", err);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// Top-10 reytingni olish
app.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, username, score FROM leaderboard ORDER BY score DESC LIMIT 10`
    );

    const enriched = await Promise.all(
      rows.map(async r => ({
        username: r.username,
        score: r.score,
        photo_url: await getUserPhoto(r.user_id)
      }))
    );

    res.json(enriched);
  } catch (err) {
    console.error("Leaderboard xatolik:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// Serverni ishga tushirish
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT} portda ishga tushdi`));
