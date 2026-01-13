const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Ma'lumotlarni xotirada saqlash (Server o'chsa o'chadi, lekin boshlanishiga yetadi)
let leaderboard = [];

// Ballarni saqlash
app.post('/save', (req, res) => {
    const { name, score, userId } = req.body;
    
    let player = leaderboard.find(p => p.userId === userId);
    if (player) {
        if (score > player.score) player.score = score;
    } else {
        leaderboard.push({ name, score, userId });
    }

    leaderboard.sort((a, b) => b.score - a.score);
    leaderboard = leaderboard.slice(0, 10); // Faqat Top 10
    res.json({ success: true });
});

// Reytingni olish
app.get('/leaderboard', (req, res) => {
    res.json(leaderboard);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
