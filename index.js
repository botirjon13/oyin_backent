const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Ballarni saqlash
app.post('/save', async (req, res) => {
    const { name, score, userId } = req.body;
    try {
        await prisma.leaderboard.upsert({
            where: { userId: userId.toString() },
            update: {
                score: score,
                name: name
            },
            create: {
                userId: userId.toString(),
                name: name,
                score: score
            },
        });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server xatosi" });
    }
});

// Reytingni olish (Top 10)
app.get('/leaderboard', async (req, res) => {
    try {
        const topScores = await prisma.leaderboard.findMany({
            orderBy: { score: 'desc' },
            take: 10,
            select: { name: true, score: true }
        });
        res.json(topScores);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server xatosi" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server port ${PORT} da ishga tushdi`));
