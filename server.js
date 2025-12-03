const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const PORT = process.env.PORT || 3000;

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

// --- AKILLI YORUM FİLTRESİ ---
function isDescriptiveReview(text) {
    const t = text.toLowerCase().trim();

    // 1. UZUNLUK KONTROLÜ (John Wick standardı: max 400)
    if (t.length > 400) return false;
    if (t.length < 30) return false;

    // 2. YASAKLI KELİMELER
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim"];
    for (let f of forbidden) { if (t.includes(f)) return false; }

    // 3. İNGİLİZCE KONTROLÜ
    const commonEnglish = [" the ", " is ", " and ", " this ", " game ", " good ", " bad ", " with "];
    let count = 0;
    for(let word of commonEnglish) { if(t.includes(word)) count++; }
    if (count >= 2) return false;

    // 4. ANAHTAR KELİME KONTROLÜ (Oyunla ilgili terimler geçiyor mu?)
    // Bu, "çok güzel oyun" gibi boş yorumları eler.
    const keywords = [
        "hikaye", "grafik", "atmosfer", "mekanik", "oynanış", "bölüm", 
        "karakter", "vuruş", "savaş", "dünya", "yapay zeka", "optimizasyon",
        "görev", "müzik", "ses", "fizik", "bug", "hatası", "server", "hile",
        "arkadaş", "zevk", "sarıyor", "efsane", "anlatım", "sonu", "fiyat"
    ];
    
    // Eğer küfür varsa (bizim kültürde komik sayılır) veya anahtar kelime varsa geçir.
    const hasProfanity = ["amk", "aq", "oç", "piç", "siktir", "yarak"].some(w => t.includes(w));
    const hasKeyword = keywords.some(kw => t.includes(kw));

    return hasKeyword || hasProfanity;
}

// --- API: OYUN İSİMLERİ (AUTOCOMPLETE İÇİN) ---
app.get('/api/all-games', (req, res) => {
    const names = GAME_IDS.map(g => g.name);
    res.json(names);
});

// --- API: OYUNLARI VE İPUÇLARINI GETİR ---
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

    // 'all' filtresi kullanarak daha çeşitli yorumlar çekiyoruz
    const filterType = 'all'; 

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;

            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=${filterType}&num_per_page=100`;
            
            try {
                const reviewResponse = await axios.get(reviewUrl);
                const reviewsRaw = reviewResponse.data.reviews;

                if (!reviewsRaw || reviewsRaw.length === 0) continue;

                let validReviews = reviewsRaw
                    .filter(r => isDescriptiveReview(r.review)) 
                    .map(r => ({
                        text: maskGameName(r.review, game.name),
                        playtime: Math.floor(r.author.playtime_forever / 60)
                    }));

                // İlk 20 kaliteli yorumu alıp karıştır
                validReviews = shuffleArray(validReviews.slice(0, 20));

                if (validReviews.length < 3) continue;

                const finalReviews = validReviews.slice(0, 10);

                resultData.push({
                    id: game.id,
                    name: game.name,
                    category: game.tags.join(', '),
                    image: imageUrl,
                    reviews: finalReviews
                });
            } catch (innerErr) {
                continue;
            }
        }
        
        res.json(resultData);

    } catch (error) {
        console.error("Hata:", error.message);
        res.status(500).json({ error: "Veri çekilemedi" });
    }
});

// ... (Diğer API'ler ve Frontend Sunumu aynı)
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

app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/logo.png', (req, res) => { res.sendFile(__dirname + '/logo.png'); });
app.get('/privacy', (req, res) => { res.sendFile(__dirname + '/privacy.html'); });
app.get('/ads.txt', (req, res) => { res.sendFile(__dirname + '/ads.txt'); });
app.get('/sitemap.xml', (req, res) => { res.sendFile(__dirname + '/sitemap.xml'); });
app.get('/robots.txt', (req, res) => { res.sendFile(__dirname + '/robots.txt'); });

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: Port ${PORT}`);
});