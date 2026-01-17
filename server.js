const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const crypto = require("crypto");
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
        diamonds INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        cost_diamonds INTEGER NOT NULL,
        description TEXT DEFAULT '',
        is_active BOOLEAN DEFAULT TRUE,
        stock INTEGER DEFAULT 100000,
        expires_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_coupons (
        id SERIAL PRIMARY KEY,
        user_identity TEXT NOT NULL,
        coupon_id INTEGER NOT NULL REFERENCES coupons(id),
        token TEXT UNIQUE NOT NULL,
        voucher_code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP NULL
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_score ON users(score DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_last_played ON users(last_played);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_coupons_user ON user_coupons(user_identity);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_coupons_status ON user_coupons(status);`);

    console.log("DB init: jadval/indekslar mavjud ✅");
  } catch (e) {
    console.error("DB init xato:", e);
  }
}
initDB();

app.get("/", (req, res) => res.json({ status: "ok" }));

/* REGISTER (oldingi mantiq) */
app.post("/register", async (req, res) => {
  try {
    const { mode, telegram_id, guest_id, username, avatar_id } = req.body || {};

    const safeAvatarId = Number.isFinite(Number(avatar_id)) ? Number(avatar_id) : 1;
    const safeUsername = (username ? String(username) : "NoName").slice(0, 60);

    if (mode === "telegram" && telegram_id) {
      const tgId = Number(telegram_id);
      const identity = `tg_${tgId}`;

      const { rows } = await pool.query(
        `
        INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id, last_played)
        VALUES ($1, $2, FALSE, $3, $4, NOW())
        ON CONFLICT (telegram_id)
        DO UPDATE SET
          identity=EXCLUDED.identity,
          is_guest=FALSE,
          username=EXCLUDED.username,
          avatar_id=EXCLUDED.avatar_id,
          last_played=NOW()
        RETURNING identity, telegram_id, is_guest, username, avatar_id, score, diamonds;
        `,
        [identity, tgId, safeUsername, safeAvatarId]
      );

      return res.json({ ok: true, user: rows[0] });
    }

    if (mode === "guest" && guest_id) {
      const identity = `guest_${String(guest_id)}`;

      const { rows } = await pool.query(
        `
        INSERT INTO users (identity, telegram_id, is_guest, username, avatar_id, last_played)
        VALUES ($1, NULL, TRUE, $2, $3, NOW())
        ON CONFLICT (identity)
        DO UPDATE SET
          username=EXCLUDED.username,
          avatar_id=EXCLUDED.avatar_id,
          last_played=NOW()
        RETURNING identity, telegram_id, is_guest, username, avatar_id, score, diamonds;
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

/* SAVE: score + earned_diamonds */
app.post("/save", async (req, res) => {
  try {
    const { identity, score, earned_diamonds } = req.body || {};
    if (!identity) return res.status(400).json({ ok: false, error: "identity_required" });

    const safeScore = Number.isFinite(Number(score)) ? Number(score) : 0;
    const addDiamonds = Number.isFinite(Number(earned_diamonds)) ? Math.max(0, Number(earned_diamonds)) : 0;

    const { rows } = await pool.query(
      `
      UPDATE users
      SET score = GREATEST(score, $2),
          diamonds = GREATEST(0, diamonds + $3),
          last_played = NOW()
      WHERE identity = $1
      RETURNING score, diamonds;
      `,
      [String(identity), safeScore, addDiamonds]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: "user_not_found" });
    return res.json({ ok: true, highScore: rows[0].score, diamonds: rows[0].diamonds });
  } catch (e) {
    console.error("SAVE ERROR:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

/* LEADERBOARD */
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

/* ---- COUPONS ---- */

// Catalog
app.get("/coupons", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, title, cost_diamonds, description, is_active, stock, expires_at
      FROM coupons
      WHERE is_active = TRUE AND stock > 0
      ORDER BY cost_diamonds ASC, id ASC;
    `);
    res.json({ ok: true, coupons: rows });
  } catch (e) {
    console.error("COUPONS ERROR:", e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// Mening kuponlarim
app.get("/my/coupons", async (req, res) => {
  try {
    const identity = String(req.query.identity || "");
    if (!identity) return res.status(400).json({ ok: false, error: "identity_required" });

    const { rows } = await pool.query(
      `
      SELECT uc.id, uc.voucher_code, uc.status, uc.created_at, uc.used_at,
             c.title, c.cost_diamonds
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_identity = $1
      ORDER BY uc.created_at DESC
      LIMIT 50;
      `,
      [identity]
    );

    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("MY COUPONS ERROR:", e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// Almashtirish
app.post("/coupons/exchange", async (req, res) => {
  const client = await pool.connect();
  try {
    const { identity, coupon_id } = req.body || {};
    if (!identity || !coupon_id) return res.status(400).json({ ok: false, error: "bad_request" });

    await client.query("BEGIN");

    const userRes = await client.query(
      `SELECT identity, diamonds FROM users WHERE identity = $1 FOR UPDATE;`,
      [String(identity)]
    );
    if (!userRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const couponRes = await client.query(
      `SELECT id, title, cost_diamonds, stock, is_active FROM coupons WHERE id = $1 FOR UPDATE;`,
      [Number(coupon_id)]
    );
    if (!couponRes.rows.length || !couponRes.rows[0].is_active) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "coupon_not_found" });
    }

    const coupon = couponRes.rows[0];
    const diamonds = Number(userRes.rows[0].diamonds) || 0;

    if (coupon.stock <= 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: false, error: "OUT_OF_STOCK" });
    }

    if (diamonds < coupon.cost_diamonds) {
      await client.query("ROLLBACK");
      return res.json({ ok: false, error: "NOT_ENOUGH_DIAMONDS", need: coupon.cost_diamonds, have: diamonds });
    }

    // token + voucher_code
    const token = crypto.randomBytes(16).toString("hex");

    // Voucher code format: TM-<short>-<6chars>
    const short =
      coupon.title.includes("50 000") ? "50K" :
      coupon.title.includes("100 000") ? "100K" :
      "GIFT";
    const rand6 = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
    const voucher_code = `TM-${short}-${rand6}`;

    // Redeem URL (QR ichida)
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://oyinbackent-production.up.railway.app";
    const redeemUrl = `${baseUrl}/redeem?token=${token}`;

    const qr_data_url = await QRCode.toDataURL(redeemUrl, { margin: 1, width: 300 });

    // diamonds yechamiz + stock kamaytiramiz + sertifikat yaratamiz
    await client.query(
      `UPDATE users SET diamonds = diamonds - $2, last_played = NOW() WHERE identity = $1;`,
      [String(identity), Number(coupon.cost_diamonds)]
    );

    await client.query(
      `UPDATE coupons SET stock = stock - 1 WHERE id = $1;`,
      [Number(coupon.id)]
    );

    const insertRes = await client.query(
      `
      INSERT INTO user_coupons (user_identity, coupon_id, token, voucher_code, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING id, created_at;
      `,
      [String(identity), Number(coupon.id), token, voucher_code]
    );

    const newDiamondsRes = await client.query(`SELECT diamonds FROM users WHERE identity=$1;`, [String(identity)]);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      certificate: {
        id: insertRes.rows[0].id,
        title: coupon.title,
        cost_diamonds: coupon.cost_diamonds,
        voucher_code,
        qr_data_url,
        status: "active",
        created_at: insertRes.rows[0].created_at,
        diamonds_left: Number(newDiamondsRes.rows[0].diamonds) || 0
      }
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("EXCHANGE ERROR:", e);
    return res.status(500).json({ ok: false, error: "db_error" });
  } finally {
    client.release();
  }
});

// Redeem (QR scan)
app.get("/redeem", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).send("Token yo‘q");

    const { rows } = await pool.query(
      `
      SELECT uc.id, uc.status, uc.voucher_code, c.title
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.token = $1
      LIMIT 1;
      `,
      [token]
    );

    if (!rows.length) return res.status(404).send("Kupon topilmadi (invalid).");

    const item = rows[0];

    if (item.status === "used") {
      return res.send(`Kupon avval ishlatilgan ✅<br><b>${item.title}</b><br>Kod: <b>${item.voucher_code}</b>`);
    }

    // ishlatilmagan bo‘lsa used qilamiz
    await pool.query(
      `UPDATE user_coupons SET status='used', used_at=NOW() WHERE id=$1;`,
      [item.id]
    );

    return res.send(`Kupon tasdiqlandi ✅<br><b>${item.title}</b><br>Kod: <b>${item.voucher_code}</b>`);
  } catch (e) {
    console.error("REDEEM ERROR:", e);
    return res.status(500).send("Server xatosi");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server portda ishga tushdi: ${PORT}`));
