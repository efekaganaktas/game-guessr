const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const PORT = process.env.PORT || 3000;

// OYUN LİSTESİNİ YÜKLE
let GAME_IDS = [];
try {
    GAME_IDS = require('./games');
} catch (e) {
    console.error("HATA: games.js dosyası bulunamadı veya hatalı!", e);
    GAME_IDS = [{ id: 730, name: "Counter-Strike 2", tags: ["Aksiyon"] }];
}

// --- GEÇİCİ HAFIZA ---
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
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim", "cumhurbaşkanı"];
    for (let f of forbidden) { if (t.includes(f)) return false; }
    
    if (t.length > 400) return false;
    if (t.length < 20) return false;
    
    // İngilizce yorumları elemek için basit kontrol
    const commonEnglish = [" the ", " is ", " and ", " this ", " game "];
    let enCount = 0;
    for(let w of commonEnglish) { if(t.includes(w)) enCount++; }
    if (enCount >= 2) return false;

    return true;
}

// --- API ENDPOINTLERİ ---

// 1. Oyun İsimlerini Getir
app.get('/api/all-games', (req, res) => {
    const names = GAME_IDS.map(g => g.name);
    res.json(names);
});

// 2. Oyun Sorusu Getir (GÜNCELLENDİ: Detay Bilgileri Ekledi)
app.get('/api/game-quiz', async (req, res) => {
    const category = req.query.category;
    let pool = [];

    if (!category || category === "Tümü" || category === "Karışık") {
        pool = GAME_IDS;
    } else {
        pool = GAME_IDS.filter(g => g.tags.includes(category));
    }

    // Havuz küçükse rastgele oyunlarla tamamla
    if (pool.length < 10) {
        const others = GAME_IDS.filter(g => !pool.includes(g));
        pool = pool.concat(shuffleArray(others).slice(0, 15 - pool.length));
    }

    const shuffledGames = shuffleArray([...pool]); 
    const resultData = [];
    const MAX_GAMES = 10;

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;

            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=all&num_per_page=50`;
            
            // Oyun Detaylarını Çek (Yeni Eklenen Kısım)
            let gameDetails = { developer: "Bilinmiyor", date: "Bilinmiyor", likes: "0" };
            try {
                // Not: Steam Store API rate-limit uygulayabilir, bu yüzden hata olursa oyunu patlatmıyoruz.
                const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${game.id}&l=turkish`;
                const detailRes = await axios.get(detailsUrl);
                if(detailRes.data && detailRes.data[game.id] && detailRes.data[game.id].success) {
                    const data = detailRes.data[game.id].data;
                    gameDetails = {
                        developer: data.developers ? data.developers[0] : "Bilinmiyor",
                        date: data.release_date ? data.release_date.date : "Bilinmiyor",
                        likes: data.recommendations ? data.recommendations.total.toLocaleString() : "0"
                    };
                }
            } catch (detailErr) {
                console.log(`Detay çekilemedi: ${game.name}`);
            }

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

                // validReviews = shuffleArray(validReviews); // İsteğe bağlı karıştırma

                if (validReviews.length < 3) continue;

                resultData.push({
                    id: game.id,
                    name: game.name,
                    category: game.tags.join(', '),
                    image: imageUrl,
                    details: gameDetails, // Detayları frontend'e gönder
                    reviews: validReviews.slice(0, 10)
                });
            } catch (innerErr) { continue; }
        }
        res.json(resultData);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Veri çekilemedi" });
    }
});

// 3. Skor Kaydet
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

// 4. Liderlik Tablosu
app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

// DOSYA SUNUMU
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/logo.png', (req, res) => { res.sendFile(__dirname + '/logo.png'); });
app.get('/privacy', (req, res) => { res.sendFile(__dirname + '/privacy.html'); });
app.get('/ads.txt', (req, res) => { res.sendFile(__dirname + '/ads.txt'); });
app.get('/sitemap.xml', (req, res) => { res.sendFile(__dirname + '/sitemap.xml'); });
app.get('/robots.txt', (req, res) => { res.sendFile(__dirname + '/robots.txt'); });

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: Port ${PORT}`);
});