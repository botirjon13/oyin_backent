const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { fetch } = require("undici"); // undici bilan fetch ishlaydi

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Telegram foydalanuvchi fotosini olish
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

// Leaderboard endpoint
app.get("/leaderboard", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, username, name, score FROM leaderboard ORDER BY score DESC LIMIT 10`
    );

    const enriched = await Promise.all(
      rows.map(async (r) => ({
        name: r.name,
        username: r.username || null,
        score: r.score,
        photo: await getUserPhoto(r.user_id)
      }))
    );

    res.json(enriched);
  } catch (e) {
    console.error("DB error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

// O'yinchi ball qo'shish endpoint
app.post("/add-score", async (req, res) => {
  const { user_id, username, name, score } = req.body;
  if (!user_id || !name || !score) return res.status(400).json({ error: "Missing fields" });

  try {
    await pool.query(
      `INSERT INTO leaderboard (user_id, username, name, score)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id)
       DO UPDATE SET score = EXCLUDED.score, username = EXCLUDED.username, name = EXCLUDED.name`,
      [user_id, username || null, name, score]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("Save error:", e);
    res.status(500).json({ error: "DB error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
});
