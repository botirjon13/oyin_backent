const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL ulanishi
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

// DB init (jadvalni siz SQL bilan yaratgansiz, lekin bu ham zarar qilmaydi)
async function initDB() {
  try {
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

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_played ON users(last_played);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users(is_guest);`);

    console.log("DB tayyor ✅");
  } catch (err) {
    console.error("DB init xato:", err);
  }
}
initDB();

function safeText(v, max = 40) {
  if (!v) return null;
  return String(v).trim().slice(0, max);
}

// 1) Auto-registratsiya (kirishda chaqiriladi)
app.post("/register", async (req, res) => {
  const { mode, telegram_id, username, avatar_id, guest_id } = req.body;

  const isTelegram = mode === "telegram" && telegram_id;
  const isGuest = mode === "guest" && guest_id;

  if (!isTelegram && !isGuest) {
    return res.status(400).json({ error: "Invalid register payload" });
  }

  const identity = isTelegram ? `tg:${telegram_id}` : `guest:${guest_id}`;

  const safeAvatarId = Number.isInteger(Number(avatar_id)) ? Number(avatar_id) : 1;
  const safeUsername =
    safeText(username, 40) ||
    (isTelegram ? `tg_${telegram_id}` : `guest_${String(guest_id).slice(0, 6)}`);

  try {
    const q = `
      INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (identity)
      DO UPDATE SET
        username = EXCLUDED.username,
        avatar_id = EXCLUDED.avatar_id,
        last_played = CURRENT_TIMESTAMP
      RETURNING identity, is_guest, username, avatar_id, score;
    `;

    const result = await pool.query(q, [
      identity,
      isTelegram ? telegram_id : null,
      isTelegram ? false : true,
      safeUsername,
      safeAvatarId
    ]);

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "DB Error" });
  }
});

// 2) Score saqlash (best score)
app.post("/save", async (req, res) => {
  const { identity, score } = req.body;

  if (!identity) return res.status(400).json({ error: "identity kerak" });

  const safeScore = Number(score);
  if (!Number.isInteger(safeScore) || safeScore < 0 || safeScore > 200000) {
    return res.status(400).json({ error: "Invalid score" });
  }

  try {
    const q = `
      UPDATE users
      SET score = GREATEST(score, $2),
          last_played = CURRENT_TIMESTAMP
      WHERE identity = $1
      RETURNING score, is_guest;
    `;
    const r = await pool.query(q, [identity, safeScore]);

    if (r.rowCount === 0) {
      return res.status(400).json({ error: "User registratsiya qilinmagan" });
    }

    res.json({ ok: true, highScore: r.rows[0].score, is_guest: r.rows[0].is_guest });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ error: "DB Error" });
  }
});

// 3) Top-10 (Variant 1: Guest ham ko'rinadi)
app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT username AS nickname, avatar_id, score, is_guest
      FROM users
      ORDER BY score DESC, last_played ASC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "DB Error" });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`));
