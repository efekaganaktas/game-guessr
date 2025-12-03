const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const PORT = process.env.PORT || 3000;

// OYUN HAVUZU (Hata önleyici ile)
let GAME_IDS = [];
try {
    GAME_IDS = require('./games');
} catch (e) {
    console.error("games.js dosyası bulunamadı, yedek liste kullanılıyor.");
    GAME_IDS = [{ id: 730, name: "Counter-Strike 2", tags: ["Aksiyon"] }];
}

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

function isFunnyReview(text) {
    const t = text.toLowerCase().trim();
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim", "erdoğan"];
    for (let f of forbidden) { if (t.includes(f)) return false; }
    
    // John Wick standardı (Max 300 karakter)
    if (t.length > 300) return false;
    if (t.length < 20) return false;
    
    const commonEnglish = [" the ", " is ", " and ", " this "];
    let enCount = 0;
    for(let w of commonEnglish) { if(t.includes(w)) enCount++; }
    if (enCount >= 2) return false;

    const boringPhrases = ["tavsiye ederim", "öneririm", "10/10", "güzel oyun", "harika oyun", "mükemmel oyun", "efsane oyun"];
    if (t.length < 80) { for (let p of boringPhrases) { if (t.includes(p)) return false; } }
    if (/^(\w)\1+$/.test(t)) return false; 

    return true;
}

// --- API ENDPOINTLERİ ---

// Autocomplete için oyun isimleri
app.get('/api/all-games', (req, res) => {
    const names = GAME_IDS.map(g => g.name);
    res.json(names);
});

// Oyun sorusu ve detayları
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
    const filterType = 'funny'; // Komik yorumlar öncelikli

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;

            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            
            // İPUCU VERİLERİ (Tarih ve İnceleme Sayısı)
            let releaseDate = "Bilinmiyor";
            let totalReviews = "Çok";

            try {
                // Mağaza verisini çekiyoruz
                const storeUrl = `https://store.steampowered.com/api/appdetails?appids=${game.id}&l=turkish`;
                const storeRes = await axios.get(storeUrl);
                if (storeRes.data[game.id] && storeRes.data[game.id].success) {
                    const data = storeRes.data[game.id].data;
                    if(data.release_date) releaseDate = data.release_date.date;
                    if(data.recommendations) totalReviews = data.recommendations.total.toLocaleString("tr-TR");
                }
            } catch (err) {
                // Mağaza verisi gelmezse oyunu bozma, devam et
            }

            // YORUMLARI ÇEK
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=${filterType}&num_per_page=100`;
            
            try {
                const reviewResponse = await axios.get(reviewUrl);
                const reviewsRaw = reviewResponse.data.reviews;

                if (!reviewsRaw || reviewsRaw.length === 0) continue;

                let validReviews = reviewsRaw
                    .filter(r => isFunnyReview(r.review)) 
                    .map(r => ({
                        text: maskGameName(r.review, game.name),
                        playtime: Math.floor(r.author.playtime_forever / 60)
                    }));

                validReviews = shuffleArray(validReviews);

                if (validReviews.length < 3) continue;

                resultData.push({
                    id: game.id,
                    name: game.name,
                    category: game.tags.join(', '),
                    image: imageUrl,
                    date: releaseDate, // İpucu için eklendi
                    reviews_count: totalReviews, // İpucu için eklendi
                    reviews: validReviews.slice(0, 10)
                });
            } catch (innerErr) { continue; }
        }
        res.json(resultData);
    } catch (error) {
        console.error("Genel Hata:", error.message);
        res.status(500).json({ error: "Veri çekilemedi" });
    }
});

// Skor Kaydet
app.post('/api/submit-score', (req, res) => {
    const { username, category, score } = req.body;
    if (!username) return res.status(400).json({ error: "Eksik bilgi" });
    const existingIndex = GLOBAL_SCORES.findIndex(s => s.username === username && s.category === category);
    if (existingIndex > -1) {
        if (score > GLOBAL_SCORES[existingIndex].score) GLOBAL_SCORES[existingIndex].score = score;
    } else {
        GLOBAL_SCORES.push({ username, category, score });
    }
    res.json({ success: true });
});

// Liderlik Tablosu
app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

// Dosya Sunumu
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/logo.png', (req, res) => { res.sendFile(__dirname + '/logo.png'); });
app.get('/privacy', (req, res) => { res.sendFile(__dirname + '/privacy.html'); });
app.get('/ads.txt', (req, res) => { res.sendFile(__dirname + '/ads.txt'); });
app.get('/sitemap.xml', (req, res) => { res.sendFile(__dirname + '/sitemap.xml'); });
app.get('/robots.txt', (req, res) => { res.sendFile(__dirname + '/robots.txt'); });

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: Port ${PORT}`);
});