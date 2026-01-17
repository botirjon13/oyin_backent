const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

async function initDB() {
  try {
    // 1) Jadval bo'lmasa yaratadi (sizda bor bo'lsa, tegmaydi)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE,
        username TEXT,
        avatar_url TEXT,
        score INTEGER DEFAULT 0,
        last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2) Eski jadval bo'lsa ham - kerakli ustunlarni qo'shib chiqamiz
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS identity TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`);

    // 3) identity ni to'ldirib qo'yish (NULL bo'lsa)
    // telegram_id bo'lsa tg:..., bo'lmasa guest:...
    await pool.query(`
      UPDATE users
      SET identity = CASE
        WHEN telegram_id IS NOT NULL THEN 'tg:' || telegram_id::text
        ELSE 'guest:' || id::text
      END
      WHERE identity IS NULL;
    `);

    // 4) telegram_id bor bo'lsa guest emas deb belgilash
    await pool.query(`
      UPDATE users
      SET is_guest = FALSE
      WHERE telegram_id IS NOT NULL;
    `);

    // 5) identity unique bo'lishi kerak (bor bo'lsa xato bermasligi uchun try/catch)
    try {
      await pool.query(`ALTER TABLE users ADD CONSTRAINT users_identity_unique UNIQUE (identity);`);
    } catch (e) {
      // constraint bor bo'lsa e'tibor bermaymiz
    }

    // 6) Indexlar (is_guest bor bo'lgandan keyin)
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

// REGISTER
app.post("/register", async (req, res) => {
  const { mode, telegram_id, username, avatar_id, guest_id } = req.body;

  const isTelegram = mode === "telegram" && telegram_id;
  const isGuest = mode === "guest" && guest_id;

  if (!isTelegram && !isGuest) {
    return res.status(400).json({ error: "Invalid register payload" });
  }

  const safeAvatarId = Number.isInteger(Number(avatar_id)) ? Number(avatar_id) : 1;
  const safeUsername = (username && String(username).slice(0, 40)) || (isTelegram ? `tg_${telegram_id}` : `guest_${String(guest_id).slice(0, 6)}`);

  try {
    let result;

    if (isTelegram) {
      const identity = `tg:${telegram_id}`;

      // TELEGRAM: telegram_id UNIQUE bo'lsa ham yiqilmaydi
      result = await pool.query(
        `
        INSERT INTO users (telegram_id, identity, is_guest, username, avatar_id)
        VALUES ($1, $2, FALSE, $3, $4)
        ON CONFLICT (telegram_id)
        DO UPDATE SET
          identity = EXCLUDED.identity,
          is_guest = FALSE,
          username = EXCLUDED.username,
          avatar_id = EXCLUDED.avatar_id,
          last_played = CURRENT_TIMESTAMP
        RETURNING identity, is_guest, username, avatar_id, score;
        `,
        [telegram_id, identity, safeUsername, safeAvatarId]
      );
    } else {
      const identity = `guest:${guest_id}`;

      // GUEST: identity UNIQUE bo'yicha
      result = await pool.query(
        `
        INSERT INTO users (identity, is_guest, username, avatar_id)
        VALUES ($1, TRUE, $2, $3)
        ON CONFLICT (identity)
        DO UPDATE SET
          username = EXCLUDED.username,
          avatar_id = EXCLUDED.avatar_id,
          last_played = CURRENT_TIMESTAMP
        RETURNING identity, is_guest, username, avatar_id, score;
        `,
        [identity, safeUsername, safeAvatarId]
      );
    }

    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "DB Error" });
  }
});

// SAVE SCORE (best)
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

// LEADERBOARD (Top-10)
app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        username AS nickname,
        avatar_id,
        score,
        is_guest
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

app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`));
