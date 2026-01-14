const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB-ga ulanish (Railway-da DB_URL o'zgaruvchisini sozlang)
const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/tomama_game";
mongoose.connect(mongoURI)
    .then(() => console.log("MongoDB-ga ulanish muvaffaqiyatli!"))
    .catch(err => console.error("DB ulanishda xato:", err));

// Foydalanuvchi sxemasi
const userSchema = new mongoose.Schema({
    telegram_id: { type: Number, required: true, unique: true },
    username: { type: String, default: "O'yinchi" },
    score: { type: Number, default: 0 },
    diamonds: { type: Number, default: 0 },
    lastPlayed: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// 1. Ballarni saqlash va Ro'yxatdan o'tish
app.post('/save', async (req, res) => {
    const { telegram_id, username, score } = req.body;

    if (!telegram_id) return res.status(400).send("ID yetishmayapti");

    try {
        let user = await User.findOne({ telegram_id });

        if (user) {
            // Agar yangi ball eski baldan yuqori bo'lsa yangilaymiz
            if (score > user.score) {
                user.score = score;
            }
            user.username = username; // Ism o'zgargan bo'lsa yangilash
            user.lastPlayed = Date.now();
            await user.save();
        } else {
            // Yangi foydalanuvchi yaratish
            user = new User({ telegram_id, username, score });
            await user.save();
        }

        res.json({ status: "ok", highScore: user.score });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. TOP 10 Reytingni olish
app.get('/leaderboard', async (req, res) => {
    try {
        const topPlayers = await User.find()
            .sort({ score: -1 }) // Ballar bo'yicha kamayish
            .limit(10)           // Faqat 10 ta
            .select('username score -_id'); // Faqat kerakli maydonlar

        res.json(topPlayers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda...`));
