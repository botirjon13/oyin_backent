// server.js (FULL - UPDATED)
// Node + Express + Postgres + Coupons (QR) + Mark-used on DOWNLOAD
// Works with Railway DATABASE_URL
// -----------------------------------

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const QRCode = require("qrcode");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

const PORT = process.env.PORT || 8080;

// Railway Postgres usually requires SSL in production
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// ----------------------
// DB INIT (safe migrations)
// ----------------------
async function initDB() {
  // 1) users table (base)
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

  // 2) add diamonds column if missing (this prevents "column diamonds does not exist")
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS diamonds INTEGER DEFAULT 0;`);

  // 3) Make telegram_id nullable (guest rows must allow NULL)
  // If it is already nullable, no problem.
  await pool.query(`ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;`).catch(() => {});

  // 4) Unique telegram_id only when NOT NULL (prevents duplicate TG users, allows guest NULL)
  // Drop old constraint/index names if they exist
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_id_key;`).catch(() => {});
  await pool.query(`DROP INDEX IF EXISTS users_telegram_id_key;`).catch(() => {});
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_unique
    ON users(telegram_id)
    WHERE telegram_id IS NOT NULL;
  `);

  // 5) indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_played ON users(last_played);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users(is_guest);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_identity ON users(identity);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);`);

  // 6) coupons catalog
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      cost_diamonds INTEGER NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 7) user coupons
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_coupons_token ON user_coupons(token);`);

  // 8) Catalog seed (only if empty)
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
  if (!u) return "O‘yinchi";
  return u.slice(0, 48);
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

function getRedeemBase(req) {
  // If you have a separate public domain for redeem pages, set REDEEM_BASE_URL
  // Example: https://oyinbackent-production.up.railway.app
  return process.env.REDEEM_BASE_URL || `https://${req.headers.host}`;
}

// ----------------------
// health
// ----------------------
app.get("/", (req, res) => res.json({ ok: true, service: "tomama-backend" }));

// ----------------------
// POST /register
// body:
//  telegram: {mode:"telegram", telegram_id, username, avatar_id}
//  guest:    {mode:"guest", guest_id, username, avatar_id}
// ----------------------
app.post("/register", async (req, res) => {
  try {
    const { mode } = req.body || {};

    let identity = null;
    let telegram_id = null;
    let is_guest = true;

    if (mode === "telegram") {
      telegram_id = req.body.telegram_id;
      if (!telegram_id) return res.status(400).json({ ok: false, error: "telegram_id_required" });
      identity = makeIdentityTelegram(telegram_id);
      is_guest = false;
    } else {
      const guest_id = req.body.guest_id;
      if (!guest_id) return res.status(400).json({ ok: false, error: "guest_id_required" });
      identity = makeIdentityGuest(guest_id);
      is_guest = true;
    }

    const username = safeUsername(req.body.username);
    const avatar_id = safeAvatarId(req.body.avatar_id);

    // IMPORTANT:
    // - We do NOT require telegram_id for guest
    // - diamonds column exists (initDB migration)
    const q = `
      INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id, score, diamonds)
      VALUES ($1, $2, $3, $4, $5, 0, 0)
      ON CONFLICT (identity)
      DO UPDATE SET
        telegram_id = COALESCE(EXCLUDED.telegram_id, users.telegram_id),
        is_guest = EXCLUDED.is_guest,
        username = EXCLUDED.username,
        avatar_id = EXCLUDED.avatar_id,
        last_played = CURRENT_TIMESTAMP
      RETURNING identity, is_guest, username, avatar_id, score, diamonds;
    `;

    const r = await pool.query(q, [identity, telegram_id, is_guest, username, avatar_id]);
    return res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    console.error("REGISTER ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// POST /save
// body: { identity, score, earned_diamonds }
// - score: keep best score (GREATEST)
// - diamonds: add earned (can be 0)
// ----------------------
app.post("/save", async (req, res) => {
  try {
    const identity = String(req.body.identity || "");
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
// returns top-10 by score
// ----------------------
app.get("/leaderboard", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        username AS nickname,
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
// GET /coupons (catalog)
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
// returns token too (needed for download->mark-used, and QR generation)
// ----------------------
app.get("/my/coupons", async (req, res) => {
  try {
    const identity = String(req.query.identity || "");
    if (!identity) return res.status(400).json({ ok: false, error: "identity_required" });

    const r = await pool.query(
      `
      SELECT
        uc.voucher_code,
        uc.token,
        uc.status,
        uc.created_at,
        c.title,
        c.description,
        c.cost_diamonds
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_identity = $1
      ORDER BY uc.created_at DESC
      LIMIT 50;
      `,
      [identity]
    );

    return res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error("MY COUPONS ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// GET /coupons/qr?token=...
// returns qr_data_url for certificate modal
// ----------------------
app.get("/coupons/qr", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token_required" });

    const redeemBase = getRedeemBase(req);
    const redeemUrl = `${redeemBase}/redeem?token=${encodeURIComponent(token)}`;
    const qr_data_url = await QRCode.toDataURL(redeemUrl);

    return res.json({ ok: true, qr_data_url, redeemUrl });
  } catch (e) {
    console.error("QR ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------------
// POST /coupons/exchange
// body: { identity, coupon_id }
// - checks diamonds
// - deducts diamonds
// - creates user_coupons row (active)
// - returns certificate with QR + code
// ----------------------
app.post("/coupons/exchange", async (req, res) => {
  const client = await pool.connect();
  try {
    const identity = String(req.body.identity || "");
    const coupon_id = Number(req.body.coupon_id || 0);
    if (!identity || !coupon_id) return res.status(400).json({ ok: false, error: "bad_request" });

    await client.query("BEGIN");

    // lock user row
    const u = await client.query(`SELECT diamonds FROM users WHERE identity=$1 FOR UPDATE;`, [identity]);
    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }
    const have = Number(u.rows[0].diamonds || 0);

    // coupon check
    const c = await client.query(
      `SELECT id, title, cost_diamonds FROM coupons WHERE id=$1 AND is_active=true;`,
      [coupon_id]
    );
    if (!c.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "coupon_not_found" });
    }
    const cost = Number(c.rows[0].cost_diamonds);

    if (have < cost) {
      await client.query("ROLLBACK");
      return res.json({ ok: false, error: "NOT_ENOUGH_DIAMONDS", need: cost, have });
    }

    // deduct diamonds
    const left = have - cost;
    await client.query(`UPDATE users SET diamonds=$2 WHERE identity=$1;`, [identity, left]);

    // create coupon certificate
    const voucher_code = genVoucherCode("TM");
    const token = genToken();

    await client.query(
      `
      INSERT INTO user_coupons (user_identity, coupon_id, voucher_code, token, status)
      VALUES ($1, $2, $3, $4, 'active');
      `,
      [identity, coupon_id, voucher_code, token]
    );

    // QR
    const redeemBase = getRedeemBase(req);
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
    token, // ✅ qo‘shildi
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
// POST /coupons/download   { identity, voucher_code }
// Download qilinsa -> USED bo'ladi
// ----------------------
app.post("/coupons/download", async (req, res) => {
  const client = await pool.connect();
  try {
    const identity = String(req.body.identity || "");
    const voucher_code = String(req.body.voucher_code || "");
    if (!identity || !voucher_code) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    await client.query("BEGIN");

    // Kupon user'ga tegishlimi?
    const r = await client.query(
      `
      SELECT uc.id, uc.status, uc.token, c.title
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_identity = $1 AND uc.voucher_code = $2
      LIMIT 1
      FOR UPDATE;
      `,
      [identity, voucher_code]
    );

    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "coupon_not_found" });
    }

    const row = r.rows[0];

    // Agar oldin USED bo'lsa ham QR beramiz (lekin status o'zgarmaydi)
    const redeemBase = process.env.REDEEM_BASE_URL || `https://${req.headers.host}`;
    const redeemUrl = `${redeemBase}/redeem?token=${encodeURIComponent(row.token)}`;
    const qr_data_url = await QRCode.toDataURL(redeemUrl);

    // Download qilinsa ACTIVE -> USED bo'lsin
    if (row.status === "active") {
      await client.query(
        `UPDATE user_coupons SET status='used', used_at=CURRENT_TIMESTAMP WHERE id=$1;`,
        [row.id]
      );
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      certificate: {
        title: row.title,
        voucher_code,
        qr_data_url,
        status_after: row.status === "active" ? "used" : row.status,
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("DOWNLOAD ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    client.release();
  }
});

// ----------------------
// POST /coupons/mark-used
// body: { token }
// This is called after DOWNLOAD (not after scan)
// active -> used
// ----------------------
app.post("/coupons/mark-used", async (req, res) => {
  try {
    const token = String(req.body.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token_required" });

    const r = await pool.query(
      `
      UPDATE user_coupons
      SET status='used', used_at=CURRENT_TIMESTAMP
      WHERE token=$1 AND status='active'
      RETURNING voucher_code, status;
      `,
      [token]
    );

    if (!r.rowCount) {
      return res.json({ ok: false, error: "not_active_or_not_found" });
    }

    return res.json({ ok: true, voucher_code: r.rows[0].voucher_code, status: r.rows[0].status });
  } catch (e) {
    console.error("MARK USED ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// POST /coupons/mark-used  { token }
app.post("/coupons/mark-used", async (req, res) => {
  try {
    const token = String(req.body.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token_required" });

    const r = await pool.query(
      `UPDATE user_coupons
       SET status='used', used_at=CURRENT_TIMESTAMP
       WHERE token=$1 AND status='active'
       RETURNING id;`,
      [token]
    );

    return res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    console.error("MARK USED ERROR:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// ----------------------
// GET /redeem?token=...
// IMPORTANT: does NOT mark used (scan should not change status in your new rule)
// just shows status and code
// ----------------------
// ----------------------
// GET /redeem?token=...  (QR scan)
// Endi scan qilganda USED qilmaydi, faqat ko'rsatadi
// ----------------------
app.get("/redeem", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).send("Token required");

    const r = await pool.query(
      `SELECT voucher_code, status FROM user_coupons WHERE token=$1 LIMIT 1;`,
      [token]
    );

    if (!r.rowCount) return res.status(404).send("Invalid coupon");

    const row = r.rows[0];
    return res
      .status(200)
      .send(`Coupon: ${row.voucher_code} | Status: ${String(row.status).toUpperCase()}`);
  } catch (e) {
    console.error("REDEEM ERROR:", e);
    return res.status(500).send("Server error");
  }
});


// ----------------------
initDB()
  .then(() => app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`)))
  .catch((e) => {
    console.error("DB init fatal:", e);
    process.exit(1);
  });
