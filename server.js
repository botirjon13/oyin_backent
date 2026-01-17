const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const QRCode = require("qrcode");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

const PORT = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----------------------
// helpers
// ----------------------
function makeIdentityTelegram(telegram_id) {
  return `tg_${telegram_id}`;
}
function makeIdentityGuest(guest_id) {
  return `guest_${guest_id}`;
}
function safeUsername(username) {
  const u = String(username || "").trim();
  return u ? u.slice(0, 48) : "O‘yinchi";
}
function safeAvatarId(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1 || x > 50) return 1;
  return Math.floor(x);
}
function genVoucherCode(prefix = "TM") {
  const rnd = Math.random().toString(16).slice(2, 8).toUpperCase();
  const rnd2 = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `${prefix}-${rnd}-${rnd2}`;
}
function genToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

// ----------------------
// DB init + migrations
// ----------------------
async function initDB() {
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      identity TEXT UNIQUE NOT NULL,
      telegram_id BIGINT,
      is_guest BOOLEAN DEFAULT TRUE,
      username TEXT,
      avatar_id INTEGER DEFAULT 1,
      score INTEGER DEFAULT 0,
      diamonds INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // MUHIM: old constraint’larni tozalash (telegram_id nullable + unique only when not null)
  await pool.query(`ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;`);
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_id_key;`);
  await pool.query(`DROP INDEX IF EXISTS users_telegram_id_key;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_unique
    ON users(telegram_id)
    WHERE telegram_id IS NOT NULL;
  `);

  // indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_played ON users(last_played);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users(is_guest);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_identity ON users(identity);`);

  // coupons catalog
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      cost_diamonds INTEGER NOT NULL,
      is_active BOOLEAN DEFAULT TRUE
    );
  `);

  // user coupons
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_coupons (
      id SERIAL PRIMARY KEY,
      user_identity TEXT NOT NULL REFERENCES users(identity) ON DELETE CASCADE,
      coupon_id INTEGER NOT NULL REFERENCES coupons(id),
      voucher_code TEXT UNIQUE NOT NULL,
      token TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      used_at TIMESTAMP
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_coupons_user ON user_coupons(user_identity);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_coupons_status ON user_coupons(status);`);

  // seed coupons if empty
  const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM coupons;`);
  if (cnt.rows[0].c === 0) {
    await pool.query(
      `INSERT INTO coupons (title, description, cost_diamonds, is_active)
       VALUES
       ('50 000 so‘m voucher', 'Sertifikat (QR + Code) orqali beriladi', 100, true),
       ('100 000 so‘m voucher', 'Sertifikat (QR + Code) orqali beriladi', 200, true),
       ('1 block, 1 litr Tomama sovg‘a', 'Sertifikat (QR + Code) orqali beriladi', 300, true);`
    );
  }

  console.log("DB init: jadval/indekslar mavjud ✅");
}

// ----------------------
// POST /register
// KALIT FIKR: identity’ni frontend yuborsa — aynan shuni ishlatamiz.
// Telegramga o‘tganda guest identity’ni "upgrade" qilamiz (yangi row ochmaymiz).
// ----------------------
app.post("/register", async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode;

    // 1) identity: agar client yuborsa, shuni ishlatamiz (eng to‘g‘ri yo‘l)
    let identity = String(body.identity || "").trim();

    // 2) agar yubormasa, mode bo‘yicha yasaymiz
    let telegram_id = null;
    let is_guest = true;

    if (!identity) {
      if (mode === "telegram") {
        telegram_id = body.telegram_id;
        if (!telegram_id) return res.status(400).json({ ok: false, error: "telegram_id_required" });
        identity = makeIdentityTelegram(telegram_id);
        is_guest = false;
      } else {
        const guest_id = body.guest_id;
        if (!guest_id) return res.status(400).json({ ok: false, error: "guest_id_required" });
        identity = makeIdentityGuest(guest_id);
        is_guest = true;
      }
    } else {
      // client identity yuborgan bo‘lsa: telegram_id bo‘lsa is_guest=false
      if (mode === "telegram" && body.telegram_id) {
        telegram_id = body.telegram_id;
        is_guest = false;
      } else {
        is_guest = true;
      }
    }

    const username = safeUsername(body.username);
    const avatar_id = safeAvatarId(body.avatar_id);

    const q = `
      INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id, score, diamonds, last_played)
      VALUES ($1, $2, $3, $4, $5, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT (identity)
      DO UPDATE SET
        telegram_id = COALESCE(EXCLUDED.telegram_id, users.telegram_id),
        is_guest = EXCLUDED.is_guest,
        username = EXCLUDED.username,
        avatar_id = EXCLUDED.avatar_id,
        last_played = CURRENT_TIMESTAMP
      RETURNING identity, telegram_id, is_guest, username, avatar_id, score, diamonds;
    `;

    const r = await pool.query(q, [identity, telegram_id, is_guest, username, avatar_id]);
    return res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// POST /save  (score + earned_diamonds)
// ----------------------
app.post("/save", async (req, res) => {
  try {
    const identity = String(req.body.identity || "").trim();
    const score = Number(req.body.score || 0);
    const earned = Number(req.body.earned_diamonds || 0);

    if (!identity) return res.status(400).json({ ok: false, error: "identity_required" });

    const q = `
      UPDATE users
      SET
        score = GREATEST(score, $2),
        diamonds = GREATEST(0, diamonds + $3),
        last_played = CURRENT_TIMESTAMP
      WHERE identity = $1
      RETURNING score, diamonds;
    `;
    const r = await pool.query(q, [identity, score, earned]);

    if (!r.rowCount) return res.status(404).json({ ok: false, error: "user_not_found" });
    return res.json({ ok: true, score: r.rows[0].score, diamonds: r.rows[0].diamonds });
  } catch (e) {
    console.error("SAVE ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// GET /leaderboard
// ----------------------
app.get("/leaderboard", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT username AS nickname,
             ('assaets/avatars/' || avatar_id || '.png') AS avatar_url,
             score
      FROM users
      WHERE score > 0
      ORDER BY score DESC
      LIMIT 10;
    `);
    return res.json(r.rows);
  } catch (e) {
    console.error("LEADERBOARD ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// GET /coupons  (catalog)
// ----------------------
app.get("/coupons", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, title, description, cost_diamonds
      FROM coupons
      WHERE is_active = true
      ORDER BY cost_diamonds ASC;
    `);
    return res.json({ ok: true, coupons: r.rows });
  } catch (e) {
    console.error("COUPONS ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// GET /my/coupons?identity=...
// ----------------------
app.get("/my/coupons", async (req, res) => {
  try {
    const identity = String(req.query.identity || "").trim();
    if (!identity) return res.status(400).json({ ok: false, error: "identity_required" });

    const r = await pool.query(`
      SELECT uc.voucher_code, uc.status, uc.created_at,
             c.title
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_identity = $1
      ORDER BY uc.created_at DESC
      LIMIT 50;
    `, [identity]);

    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error("MY COUPONS ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// POST /coupons/exchange   { identity, coupon_id }
// ----------------------
app.post("/coupons/exchange", async (req, res) => {
  const client = await pool.connect();
  try {
    const identity = String(req.body.identity || "").trim();
    const coupon_id = Number(req.body.coupon_id || 0);
    if (!identity || !coupon_id) return res.status(400).json({ ok: false, error: "bad_request" });

    await client.query("BEGIN");

    const u = await client.query(`SELECT diamonds FROM users WHERE identity=$1 FOR UPDATE;`, [identity]);
    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }
    const have = Number(u.rows[0].diamonds || 0);

    const c = await client.query(`SELECT id, title, cost_diamonds FROM coupons WHERE id=$1 AND is_active=true;`, [coupon_id]);
    if (!c.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "coupon_not_found" });
    }
    const cost = Number(c.rows[0].cost_diamonds);

    if (have < cost) {
      await client.query("ROLLBACK");
      return res.json({ ok: false, error: "NOT_ENOUGH_DIAMONDS", need: cost, have });
    }

    const left = have - cost;

    await client.query(`UPDATE users SET diamonds=$2 WHERE identity=$1;`, [identity, left]);

    const voucher_code = genVoucherCode("TM");
    const token = genToken();

    await client.query(`
      INSERT INTO user_coupons (user_identity, coupon_id, voucher_code, token, status)
      VALUES ($1, $2, $3, $4, 'active');
    `, [identity, coupon_id, voucher_code, token]);

    const redeemBase = process.env.REDEEM_BASE_URL || `https://${req.headers.host}`;
    const redeemUrl = `${redeemBase}/redeem?token=${encodeURIComponent(token)}`;
    const qr_data_url = await QRCode.toDataURL(redeemUrl);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      certificate: {
        title: c.rows[0].title,
        voucher_code,
        qr_data_url,
        diamonds_left: left,
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("EXCHANGE ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// ----------------------
// GET /redeem?token=...  (QR scan)
// ----------------------
app.get("/redeem", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).send("Token required");

    const r = await pool.query(`
      SELECT id, status, voucher_code
      FROM user_coupons
      WHERE token = $1
      LIMIT 1;
    `, [token]);

    if (!r.rowCount) return res.status(404).send("Invalid coupon");

    const row = r.rows[0];
    if (row.status !== "active") return res.status(200).send(`Coupon already ${row.status.toUpperCase()}`);

    await pool.query(`
      UPDATE user_coupons
      SET status='used', used_at=CURRENT_TIMESTAMP
      WHERE id=$1;
    `, [row.id]);

    return res.status(200).send(`OK. Coupon used. Code: ${row.voucher_code}`);
  } catch (e) {
    console.error("REDEEM ERROR:", e);
    return res.status(500).send("Server error");
  }
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`)))
  .catch((e) => {
    console.error("DB init fatal:", e);
    process.exit(1);
  });
