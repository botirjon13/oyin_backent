// CommonJS format
const express = require("express");
const { Pool } = require("pg");
const fetch = require("node-fetch"); // node-fetch v2 ishlaydi
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL ulanishi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Jadvalni avtomatik yaratish
async function createLeaderboardTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        user_id BIGINT PRIMARY KEY,
        name TEXT,
        score INT DEFAULT 0,
        username TEXT,
        photo_url TEXT
      )
    `);
    console.log("Leaderboard jadvali mavjud yoki yaratildi ✅");
  } catch (err) {
    console.error("Jadval yaratishda xato:", err);
  }
}

// Telegram profil rasmini olish
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
  } catch {
    return null;
  }
}

// Leaderboardni olish
app.get("/leaderboard", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT user_id, name, score, username, photo_url FROM leaderboard ORDER BY score DESC LIMIT 10"
    );

    // Rasmlar va username bilan enrich qilish
    const enriched = await Promise.all(
      rows.map(async r => ({
        user_id: r.user_id,
        name: r.name,
        score: r.score,
        username: r.username || null,
        photo_url: r.photo_url || await getUserPhoto(r.user_id)
      }))
    );

    res.json(enriched);
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// Ball qo'shish
app.post("/score", async (req, res) => {
  const { user_id, name, username, score } = req.body;
  if (!user_id || !name || score == null) {
    return res.status(400).json({ error: "user_id, name va score kerak" });
  }

  try {
    // INSERT yoki UPDATE
    await pool.query(
      `INSERT INTO leaderboard (user_id, name, username, score)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET
         name = EXCLUDED.name,
         username = EXCLUDED.username,
         score = EXCLUDED.score
       WHERE leaderboard.score < EXCLUDED.score`,
      [user_id, name, username || null, score]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Score save error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// Server ishga tushishi
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  await createLeaderboardTable();
  console.log(`Server ${PORT} portda ishga tushdi`);
});
