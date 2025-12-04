const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const PORT = process.env.PORT || 3000;
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000; // 5 Gün

// OYUN LİSTESİNİ YÜKLE
let GAME_IDS = [];
try {
    GAME_IDS = require('./games');
} catch (e) {
    console.error("HATA: games.js dosyası bulunamadı veya hatalı!", e);
    GAME_IDS = [{ id: 730, name: "Counter-Strike 2", tags: ["Aksiyon"] }];
}

// --- GEÇİCİ HAFIZA ---
// { username, category, score, timestamp }
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

// 2. Oyun Sorusu Getir
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

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;

            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=all&num_per_page=50`;
            
            // Oyun Detaylarını Çek
            let gameDetails = { developer: "Bilinmiyor", date: "Bilinmiyor", likes: "0" };
            try {
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
                // Hata olursa varsayılan değerlerle devam et
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

                if (validReviews.length < 3) continue;

                resultData.push({
                    id: game.id,
                    name: game.name,
                    category: game.tags.join(', '),
                    image: imageUrl,
                    details: gameDetails,
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

// 3. Skor Kaydet (Güncellendi: Timestamp ve Güncelleme Mantığı)
app.post('/api/submit-score', (req, res) => {
    const { username, category, score } = req.body;
    if (!username) return res.status(400).json({ error: "Eksik bilgi" });
    
    const now = Date.now();
    const existingIndex = GLOBAL_SCORES.findIndex(s => s.username === username && s.category === category);
    
    if (existingIndex > -1) {
        // Kullanıcı varsa, son görülme zamanını güncelle
        GLOBAL_SCORES[existingIndex].timestamp = now;
        
        // Eğer yeni skor daha yüksekse skoru güncelle
        if (score > GLOBAL_SCORES[existingIndex].score) {
            GLOBAL_SCORES[existingIndex].score = score;
        }
    } else {
        // Yeni kayıt oluştur
        GLOBAL_SCORES.push({ username, category, score, timestamp: now });
    }
    res.json({ success: true });
});

// 4. Liderlik Tablosu (Güncellendi: 5 Gün Kuralı)
app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    const now = Date.now();

    // 5 günden eski kayıtları temizle
    GLOBAL_SCORES = GLOBAL_SCORES.filter(s => (now - s.timestamp) < FIVE_DAYS_MS);

    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

// 5. Çıkış Yap (Yeni Endpoint: Kullanıcıyı Sil)
app.post('/api/logout', (req, res) => {
    const { username } = req.body;
    if (username) {
        GLOBAL_SCORES = GLOBAL_SCORES.filter(s => s.username !== username);
    }
    res.json({ success: true });
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