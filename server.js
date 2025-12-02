const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const PORT = process.env.PORT || 3000;
const STEAM_API_KEY = '71BCFECF04FA7C5BC75EDCE230F2481C';

// OYUN HAVUZUNU HARİCİ DOSYADAN ÇEK
const GAME_IDS = require('./games');

// --- GEÇİCİ HAFIZA (RAM) ---
let GLOBAL_SCORES = [];

// --- YARDIMCI FONKSİYONLAR ---
function maskGameName(text, gameName) {
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let masked = text.replace(new RegExp(escapeRegExp(gameName), 'gi'), '***');
    const parts = gameName.split(/[\s:-]+/).filter(p => p.length > 3);
    parts.forEach(part => {
        masked = masked.replace(new RegExp(escapeRegExp(part), 'gi'), '***');
    });
    return masked;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function isLikelyEnglish(text) {
    const commonEnglish = [" the ", " is ", " and ", " this ", " game ", " good ", " bad ", " with ", " for ", " that "];
    let count = 0;
    const lower = text.toLowerCase();
    for(let word of commonEnglish) {
        if(lower.includes(word)) count++;
    }
    return count >= 2;
}

function isFunnyReview(text) {
    const t = text.toLowerCase().trim();
    const politicalKeywords = ["recep tayyip", "erdoğan", "erdogan", "rte", "tayyip"];
    for (let kw of politicalKeywords) { if (t.includes(kw)) return false; }
    if (t.length > 300) return false;
    if (t.length < 20) return false;
    if (isLikelyEnglish(text)) return false;
    const boringPhrases = ["tavsiye ederim", "öneririm", "10/10", "10 / 10", "güzel oyun", "harika oyun", "mükemmel oyun", "efsane oyun", "kesinlikle alın", "indirimde alın", "parasını hak", "iyi oyun", "keyifli", "zaman kaybı değil", "başarılı"];
    if (t.length < 100) { for (let phrase of boringPhrases) { if (t.includes(phrase)) return false; } }
    if (/^(\w)\1+$/.test(t)) return false; 
    return true;
}

// Ana Sayfa (Frontend Sunumu)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- API: OYUNLARI GETİR ---
app.get('/api/game-quiz', async (req, res) => {
    const category = req.query.category;
    let pool = [];

    if (!category || category === "Tümü" || category === "Karışık") {
        pool = GAME_IDS;
    } else {
        pool = GAME_IDS.filter(g => g.tags.includes(category));
    }

    if (pool.length < 10) {
        const others = GAME_IDS.filter(g => !pool.includes(g));
        pool = pool.concat(shuffleArray(others).slice(0, 15 - pool.length));
    }

    const shuffledGames = shuffleArray([...pool]); 
    const resultData = [];
    const MAX_GAMES = 10;
    const filterType = 'funny'; 

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;
            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=${filterType}&num_per_page=100`;
            try {
                const reviewResponse = await axios.get(reviewUrl);
                const reviewsRaw = reviewResponse.data.reviews;
                if (!reviewsRaw || reviewsRaw.length === 0) continue;
                let validReviews = reviewsRaw.filter(r => isFunnyReview(r.review)).map(r => ({ text: maskGameName(r.review, game.name), playtime: Math.floor(r.author.playtime_forever / 60) }));
                validReviews = shuffleArray(validReviews);
                if (validReviews.length < 3) continue;
                const finalReviews = validReviews.slice(0, 10);
                resultData.push({ id: game.id, name: game.name, category: game.tags.join(', '), image: imageUrl, reviews: finalReviews });
            } catch (innerErr) { continue; }
        }
        res.json(resultData);
    } catch (error) {
        console.error("Hata:", error.message);
        res.status(500).json({ error: "Veri çekilemedi" });
    }
});

// --- API: SKOR KAYDET ---
app.post('/api/submit-score', (req, res) => {
    const { username, category, score } = req.body;
    if (!username || !category || score === undefined) return res.status(400).json({ error: "Eksik bilgi" });

    const existingIndex = GLOBAL_SCORES.findIndex(s => s.username === username && s.category === category);
    if (existingIndex > -1) {
        if (score > GLOBAL_SCORES[existingIndex].score) GLOBAL_SCORES[existingIndex].score = score;
    } else {
        GLOBAL_SCORES.push({ username, category, score });
    }
    res.json({ success: true });
});

// --- API: LİDERLİK TABLOSU ---
app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: Port ${PORT}`);
});