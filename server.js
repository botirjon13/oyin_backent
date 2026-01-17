const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        identity TEXT UNIQUE NOT NULL,
        telegram_id BIGINT NULL,
        is_guest BOOLEAN DEFAULT TRUE,
        username TEXT,
        avatar_id INTEGER DEFAULT 1,
        score INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // indexlar
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_played ON users(last_played);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users(is_guest);`);

    console.log("DB init: users jadvali mavjud/yaratildi ✅");
  } catch (e) {
    console.error("DB init xato:", e);
  }
}
initDB();

app.get("/", (req, res) => res.json({ status: "ok" }));

/**
 * REGISTER
 * - Telegram bo'lsa: ON CONFLICT (telegram_id) -> UPDATE
 * - Guest bo'lsa:    ON CONFLICT (identity)   -> UPDATE
 */
app.post("/register", async (req, res) => {
  try {
    const { mode, telegram_id, guest_id, username, avatar_id } = req.body || {};

    const safeAvatarId = Number.isFinite(Number(avatar_id)) ? Number(avatar_id) : 1;
    const safeUsername = (username ? String(username) : "NoName").slice(0, 60);

    // TELEGRAM
    if (mode === "telegram" && telegram_id) {
      const tgId = Number(telegram_id);
      const identity = `tg_${tgId}`;

      const { rows } = await pool.query(
        `
        INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id, last_played)
        VALUES ($1, $2, FALSE, $3, $4, NOW())
        ON CONFLICT (telegram_id)
        DO UPDATE SET
          identity   = EXCLUDED.identity,
          is_guest   = FALSE,
          username   = EXCLUDED.username,
          avatar_id  = EXCLUDED.avatar_id,
          last_played= NOW()
        RETURNING identity, telegram_id, is_guest, username, avatar_id, score;
        `,
        [identity, tgId, safeUsername, safeAvatarId]
      );

      return res.json({ ok: true, user: rows[0] });
    }

    // GUEST
    if (mode === "guest" && guest_id) {
      const identity = `guest_${String(guest_id)}`;

      const { rows } = await pool.query(
        `
        INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id, last_played)
        VALUES ($1, NULL, TRUE, $2, $3, NOW())
        ON CONFLICT (identity)
        DO UPDATE SET
          username    = EXCLUDED.username,
          avatar_id   = EXCLUDED.avatar_id,
          last_played = NOW()
        RETURNING identity, telegram_id, is_guest, username, avatar_id, score;
        `,
        [identity, safeUsername, safeAvatarId]
      );

      return res.json({ ok: true, user: rows[0] });
    }

    return res.status(400).json({ ok: false, error: "invalid_payload" });
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

/**
 * SAVE SCORE: identity bo'yicha
 */
app.post("/save", async (req, res) => {
  try {
    const { identity, score } = req.body || {};
    if (!identity) return res.status(400).json({ ok: false, error: "identity_required" });

    const safeScore = Number.isFinite(Number(score)) ? Number(score) : 0;

    const { rows } = await pool.query(
      `
      UPDATE users
      SET score = GREATEST(score, $2),
          last_played = NOW()
      WHERE identity = $1
      RETURNING score;
      `,
      [String(identity), safeScore]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "user_not_found" });
    return res.json({ ok: true, highScore: rows[0].score });
  } catch (e) {
    console.error("SAVE ERROR:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

/**
 * LEADERBOARD
 */
app.get("/leaderboard", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT username, avatar_id, score, is_guest
      FROM users
      ORDER BY score DESC, last_played DESC
      LIMIT 10;
      `
    );

    const data = rows.map((r) => ({
      nickname: r.username || "NoName",
      avatar_url: `assaets/avatars/${Number(r.avatar_id) || 1}.png`,
      score: Number(r.score) || 0,
      is_guest: !!r.is_guest,
    }));

    return res.json(data);
  } catch (e) {
    console.error("LEADERBOARD ERROR:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`));
