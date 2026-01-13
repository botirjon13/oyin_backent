const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🔹 Jadvalni avtomatik yaratish (1 marta)
pool.query(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    score INTEGER NOT NULL
  )
`);

app.post('/save', async (req, res) => {
  const { userId, name, score } = req.body;
  try {
    await pool.query(
      `
      INSERT INTO leaderboard (user_id, name, score)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET score = GREATEST(leaderboard.score, EXCLUDED.score),
                    name = EXCLUDED.name
      `,
      [userId.toString(), name, score]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name, score FROM leaderboard ORDER BY score DESC LIMIT 10`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log('Server ishga tushdi')
);
