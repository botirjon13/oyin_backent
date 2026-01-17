// server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// DB init (jadval va ustunlar borligini tekshiradi)
async function initDB() {
  try {
    // Jadvalni yaratish (sizning schema bilan mos)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        identity TEXT UNIQUE NOT NULL,
        telegram_id BIGINT,
        is_guest BOOLEAN DEFAULT TRUE,
        username TEXT,
        avatar_id INTEGER DEFAULT 1,
        score INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Kerakli indexlar (IF NOT EXISTS)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_played ON users(last_played);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users(is_guest);`);

    console.log("DB init: users jadvali mavjud/yaratildi ✅");
  } catch (e) {
    console.error("DB init xato:", e);
  }
}
initDB();

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

/**
 * REGISTER
 * mode: "telegram" | "guest"
 * telegram: { telegram_id, username, avatar_id }
 * guest: { guest_id, username, avatar_id }
 */
app.post("/register", async (req, res) => {
  const {
    mode,
    telegram_id,
    guest_id,
    username,
    avatar_id
  } = req.body;

  try {
    let result;

    if (mode === "telegram" && telegram_id) {
      // 🔹 TELEGRAM USER (UPSERT)
      result = await pool.query(
        `
        INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id)
        VALUES ($1, $2, FALSE, $3, $4)
        ON CONFLICT (telegram_id)
        DO UPDATE SET
          username = EXCLUDED.username,
          avatar_id = EXCLUDED.avatar_id,
          is_guest = FALSE,
          last_played = CURRENT_TIMESTAMP
        RETURNING *;
        `,
        [
          `tg_${telegram_id}`,
          telegram_id,
          username || "Telegram User",
          avatar_id || 1
        ]
      );
    } else {
      // 🔹 GUEST USER (identity UNIQUE bo‘yicha)
      result = await pool.query(
        `
        INSERT INTO users (identity, is_guest, username, avatar_id)
        VALUES ($1, TRUE, $2, $3)
        ON CONFLICT (identity)
        DO UPDATE SET
          last_played = CURRENT_TIMESTAMP
        RETURNING *;
        `,
        [
          guest_id,
          username || "Guest",
          avatar_id || 1
        ]
      );
    }

    res.json({ ok: true, user: result.rows[0] });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ ok: false, error: "register_failed" });
  }
});
/**
 * SAVE SCORE
 * identity + score keladi (identity registratsiyadan keyin localStorage’da saqlanadi)
 * Agar identity bo'lmasa — 400
 */
app.post("/save", async (req, res) => {
  try {
    const { identity, score } = req.body || {};
    if (!identity) return res.status(400).json({ ok: false, error: "identity required" });

    const safeScore = Number.isFinite(Number(score)) ? Number(score) : 0;

    const q = `
      UPDATE users
      SET
        score = GREATEST(score, $2),
        last_played = NOW()
      WHERE identity = $1
      RETURNING score;
    `;
    const { rows } = await pool.query(q, [String(identity), safeScore]);

    if (!rows.length) return res.status(404).json({ ok: false, error: "user not found" });

    return res.json({ ok: true, highScore: rows[0].score });
  } catch (e) {
    console.error("SAVE ERROR:", e);
    return res.status(500).json({ ok: false, error: "DB error" });
  }
});

/**
 * LEADERBOARD TOP-10
 * Frontend nickname + avatar_url (avatar_id dan generatsiya qilamiz)
 */
app.get("/leaderboard", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, avatar_id, score, is_guest
      FROM users
      ORDER BY score DESC, last_played DESC
      LIMIT 10
    `);

    const data = rows.map((r) => ({
      nickname: r.username || "NoName",
      avatar_url: `assaets/avatars/${Number(r.avatar_id) || 1}.png`,
      score: Number(r.score) || 0,
      is_guest: !!r.is_guest,
    }));

    return res.json(data);
  } catch (e) {
    console.error("LEADERBOARD ERROR:", e);
    return res.status(500).json({ ok: false, error: "DB error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`));
