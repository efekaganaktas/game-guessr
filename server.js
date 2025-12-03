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
    console.error("HATA: games.js dosyası bulunamadı!", e);
    GAME_IDS = [{ id: 730, name: "Counter-Strike 2", tags: ["Aksiyon"] }];
}

// --- GEÇİCİ HAFIZA ---
let GLOBAL_SCORES = [];

// --- YARDIMCI FONKSİYONLAR ---
function maskGameName(text, gameName) {
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let masked = text.replace(new RegExp(escapeRegExp(gameName), 'gi'), '***');
    
    // Oyun adının parçalarını da maskele (örn: "Call of Duty" -> "Call", "Duty")
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

// Filtreleme Fonksiyonu (strictMode: false ise kuralları gevşetir)
function isReviewValid(text, strictMode = true) {
    const t = text.toLowerCase().trim();
    
    // Kesin Yasaklılar (Siyaset, küfür vb.)
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim", "cumhurbaşkanı", "kurdistan"];
    for (let f of forbidden) { if (t.includes(f)) return false; }

    // Uzunluk Kontrolü
    const minLen = strictMode ? 20 : 5; // Gevşek modda 5 karaktere kadar izin ver
    const maxLen = 600;
    if (t.length > maxLen) return false;
    if (t.length < minLen) return false;

    // İngilizce/Spam Kontrolü (Sadece sıkı modda)
    if (strictMode) {
        const commonEnglish = [" the ", " is ", " and ", " this ", " game ", " good ", " bad "];
        let enCount = 0;
        for(let w of commonEnglish) { if(t.includes(w)) enCount++; }
        if (enCount >= 3) return false; // Çok fazla İngilizce kelime varsa ele
    }

    return true;
}

// --- API ENDPOINTLERİ ---

// 1. Oyun İsimlerini Getir
app.get('/api/all-games', (req, res) => {
    const names = GAME_IDS.map(g => g.name);
    res.json(names);
});

// 2. Oyun Sorusu Getir (Geliştirilmiş Versiyon)
app.get('/api/game-quiz', async (req, res) => {
    const category = req.query.category;
    let pool = [];

    if (!category || category === "Tümü" || category === "Karışık") {
        pool = GAME_IDS;
    } else {
        pool = GAME_IDS.filter(g => g.tags.includes(category));
    }

    // Havuz çok küçükse rastgele oyunlarla destekle
    if (pool.length < 10) {
        const others = GAME_IDS.filter(g => !pool.includes(g));
        pool = pool.concat(shuffleArray(others).slice(0, 15 - pool.length));
    }

    const shuffledGames = shuffleArray([...pool]); 
    const resultData = [];
    const MAX_GAMES = 10; // İstemciye 10 oyun gönder

    for (let game of shuffledGames) {
        if (resultData.length >= MAX_GAMES) break;

        try {
            // 1. ADIM: Yorumları Çek (Maksimum 100 tane iste ki elenecek payı olsun)
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=all&num_per_page=100`;
            const reviewResponse = await axios.get(reviewUrl, { timeout: 3000 }); // 3sn zaman aşımı
            const reviewsRaw = reviewResponse.data.reviews;

            if (!reviewsRaw || reviewsRaw.length === 0) continue;

            // 2. ADIM: Filtreleme (Önce Sıkı, Yetmezse Gevşek)
            let validReviews = reviewsRaw
                .filter(r => isReviewValid(r.review, true)) // Sıkı Mod
                .map(r => ({
                    text: maskGameName(r.review, game.name),
                    playtime: Math.floor(r.author.playtime_forever / 60)
                }));

            // Eğer sıkı filtrede yeterli yorum çıkmadıysa gevşek modda tekrar tara
            if (validReviews.length < 5) {
                const looseReviews = reviewsRaw
                    .filter(r => isReviewValid(r.review, false)) // Gevşek Mod
                    .map(r => ({
                        text: maskGameName(r.review, game.name),
                        playtime: Math.floor(r.author.playtime_forever / 60)
                    }));
                
                // Tekrarları önlemek için birleştirme mantığı (basitçe ekliyoruz)
                validReviews = [...validReviews, ...looseReviews];
                // Benzersiz yap (Set kullanarak)
                validReviews = [...new Map(validReviews.map(item => [item.text, item])).values()];
            }

            // Hala çok azsa bu oyunu atla (Kullanıcıya boş oyun göstermektense hiç gösterme)
            if (validReviews.length < 3) continue;

            // 3. ADIM: Oyun Detaylarını Çek (Opsiyonel - Hata verirse oyun iptal olmasın)
            let gameDetails = { developer: "Bilinmiyor", date: "Belirtilmemiş", likes: "?" };
            try {
                const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${game.id}&l=turkish`;
                const detailRes = await axios.get(detailsUrl, { timeout: 2000 });
                if(detailRes.data && detailRes.data[game.id] && detailRes.data[game.id].success) {
                    const d = detailRes.data[game.id].data;
                    gameDetails = {
                        developer: d.developers ? d.developers[0] : "Bilinmiyor",
                        date: d.release_date ? d.release_date.date : "Belirtilmemiş",
                        likes: d.recommendations ? d.recommendations.total.toLocaleString() : "Az"
                    };
                }
            } catch (detErr) {
                // Detay çekilemezse varsayılanlarla devam et, sorun yok.
            }

            resultData.push({
                id: game.id,
                name: game.name,
                category: game.tags.join(', '),
                image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`,
                details: gameDetails,
                reviews: shuffleArray(validReviews).slice(0, 15) // En fazla 15 yorum gönder
            });

        } catch (err) {
            console.log(`Hata (${game.name}): ${err.message}`);
            continue;
        }
    }
    
    if (resultData.length === 0) {
        res.status(500).json({ error: "Yeterli veri bulunamadı." });
    } else {
        res.json(resultData);
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