require('dotenv').config(); // .env faylidan BOT_TOKEN va DATABASE_URL oladi
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// --- Funksiya: Telegram profil rasmini olish ---
async function getUserPhoto(userId) {
  if (!process.env.BOT_TOKEN) return null;

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

// --- Endpoint: Ballarni saqlash ---
app.post('/save', async (req, res) => {
  const { name, score, userId, username } = req.body;

  try {
    const photo_url = await getUserPhoto(userId);

    await prisma.leaderboard.upsert({
      where: { userId: userId.toString() },
      update: {
        score: score,
        name: name,
        username: username || null,
        photo_url: photo_url || null
      },
      create: {
        userId: userId.toString(),
        name: name,
        username: username || null,
        photo_url: photo_url || null,
        score: score
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Save xatolik:", err);
    res.status(500).json({ error: "Server xatosi" });
  }
});

// --- Endpoint: Top 10 leaderboard ---
app.get('/leaderboard', async (req, res) => {
  try {
    const topPlayers = await prisma.leaderboard.findMany({
      orderBy: { score: 'desc' },
      take: 10,
      select: { name: true, score: true, username: true, photo_url: true }
    });

    res.json(topPlayers);
  } catch (err) {
    console.error("Leaderboard xatolik:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// --- Serverni ishga tushirish ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
});
