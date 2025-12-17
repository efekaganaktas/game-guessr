const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());

// --- AYARLAR ---
const PORT = process.env.PORT || 3000;
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const SCORES_FILE = path.join(__dirname, 'scores.json');

// --- OYUN LİSTESİNİ YÜKLE ---
let GAME_IDS = [];
try {
    GAME_IDS = require('./games');
} catch (e) {
    console.error("HATA: games.js dosyası bulunamadı!", e);
    GAME_IDS = [{ id: 730, name: "Counter-Strike 2", tags: ["Aksiyon"] }];
}

// --- GLOBAL DEĞİŞKENLER ---
let GLOBAL_SCORES = [];
let CACHED_GAMES = []; // Tüm işlenmiş oyunlar burada tutulacak
let IS_CACHE_READY = false;

// 1. SKORLARI YÜKLE
function loadScoresFromFile() {
    if (fs.existsSync(SCORES_FILE)) {
        try {
            const data = fs.readFileSync(SCORES_FILE, 'utf8');
            GLOBAL_SCORES = JSON.parse(data);
            console.log("✅ Skorlar yüklendi.");
        } catch (err) {
            GLOBAL_SCORES = [];
        }
    }
}

// 2. ASENKRON SKOR KAYDETME (Sunucuyu dondurmaz)
async function saveScoresToFile() {
    try {
        await fs.promises.writeFile(SCORES_FILE, JSON.stringify(GLOBAL_SCORES, null, 2));
    } catch (err) {
        console.error("Skor kaydedilemedi:", err);
    }
}

loadScoresFromFile();

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

function isSafeContent(text) {
    const t = text.toLowerCase().trim();
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim", "cumhurbaşkanı", "kurdistan", "terör"];
    for (let f of forbidden) { if (t.includes(f)) return false; }
    if (t.length > 600 || t.length < 5) return false;
    const letterCount = (t.match(/[a-zğüşıöç]/g) || []).length;
    if (letterCount < 3) return false;
    return true;
}

// --- CACHE SİSTEMİ (EN ÖNEMLİ KISIM) ---

// Tek bir oyunun verisini çekip işleyen fonksiyon
async function fetchSingleGameData(game) {
    try {
        // 1. Detayları Çek
        let gameDetails = { developer: "Bilinmiyor", date: "?", likes: "0" };
        try {
            const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${game.id}&l=turkish`;
            const detailRes = await axios.get(detailsUrl, { timeout: 5000 }); // 5sn zaman aşımı
            if (detailRes.data && detailRes.data[game.id] && detailRes.data[game.id].success) {
                const data = detailRes.data[game.id].data;
                gameDetails = {
                    developer: data.developers ? data.developers[0] : "Bilinmiyor",
                    date: data.release_date ? data.release_date.date : "?",
                    likes: data.recommendations ? data.recommendations.total.toLocaleString() : "0"
                };
            }
        } catch (e) { /* Detay hatası önemsiz, varsayılanı kullan */ }

        // 2. Yorumları Çek
        const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=all&num_per_page=100&purchase_type=all`;
        const reviewResponse = await axios.get(reviewUrl, { timeout: 8000 });
        let reviewsRaw = reviewResponse.data.reviews;

        if (!reviewsRaw || reviewsRaw.length < 5) return null; // Yetersiz yorum varsa atla

        // 3. Yorumları İşle ve Filtrele
        let safeReviews = reviewsRaw.filter(r => isSafeContent(r.review));
        let informativeReviews = [];
        let funnyReviews = [];
        let fillerReviews = [];

        safeReviews.forEach(r => {
            const cleanText = r.review.replace(/\r\n/g, " ").trim();
            const item = {
                text: maskGameName(cleanText, game.name),
                playtime: Math.floor(r.author.playtime_forever / 60),
                votes: r.votes_up
            };

            const commonEnglish = [" the ", " is ", " and ", " game ", " best ", " good "];
            let enCount = 0;
            for (let w of commonEnglish) { if (item.text.toLowerCase().includes(w)) enCount++; }
            if (enCount >= 3) return;

            if (item.text.length > 60) informativeReviews.push(item);
            else if (item.text.length > 5) funnyReviews.push(item);
            else fillerReviews.push(item);
        });

        // Yeterli yorum yoksa bu oyunu pas geç
        if ((informativeReviews.length + funnyReviews.length) < 3) return null;

        // Yorum havuzunu oluştur
        informativeReviews.sort((a, b) => b.votes - a.votes);
        funnyReviews.sort((a, b) => b.votes - a.votes);

        let finalReviews = [...informativeReviews.slice(0, 15), ...funnyReviews.slice(0, 5)];
        
        return {
            id: game.id,
            name: game.name,
            category: game.tags.join(', '),
            tags: game.tags, // Filtreleme için raw tags
            image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`,
            details: gameDetails,
            reviews: finalReviews // Ham havuzu sakla, quiz sırasında karıştırıp 10 tane seçeceğiz
        };

    } catch (err) {
        return null; // Hata olursa bu oyunu atla
    }
}

// Tüm oyunları periyodik olarak güncelleyen ana fonksiyon
async function updateGameCache() {
    console.log("🔄 Oyun verileri güncelleniyor... (Bu işlem 1-2 dk sürebilir)");
    
    const tempCache = [];
    const BATCH_SIZE = 5; // Aynı anda 5 istek at (Hız ve Güvenlik Dengesi)

    for (let i = 0; i < GAME_IDS.length; i += BATCH_SIZE) {
        const batch = GAME_IDS.slice(i, i + BATCH_SIZE);
        // Promise.all ile 5 tanesini paralel çekiyoruz (HIZ KAZANIMI)
        const results = await Promise.all(batch.map(game => fetchSingleGameData(game)));
        
        results.forEach(res => {
            if (res) tempCache.push(res);
        });
        
        // Steam'i boğmamak için kısa bekleme
        await new Promise(resolve => setTimeout(resolve, 500)); 
    }

    if (tempCache.length > 0) {
        CACHED_GAMES = tempCache;
        IS_CACHE_READY = true;
        console.log(`✅ Cache Güncellendi! Toplam ${CACHED_GAMES.length} oyun hazır.`);
    }
}

// Sunucu açıldığında cache'i başlat
updateGameCache();
// Her 6 saatte bir cache'i tazele
setInterval(updateGameCache, 6 * 60 * 60 * 1000);


// --- API ENDPOINTLERİ ---

app.get('/api/all-games', (req, res) => {
    const names = GAME_IDS.map(g => g.name);
    res.json(names);
});

// GÜNCELLENEN OYUN SORUSU ROTASI (ARTIK ÇOK HIZLI)
app.get('/api/game-quiz', (req, res) => {
    // Cache hazır değilse geçici hata veya bekleme yerine basit bir kontrol
    if (!IS_CACHE_READY && CACHED_GAMES.length === 0) {
        return res.status(503).json({ error: "Sunucu hazırlanıyor, lütfen 10 saniye sonra tekrar deneyin." });
    }

    const category = req.query.category;
    let pool = [];

    // Cache'den filtrele
    if (!category || category === "Tümü" || category === "Karışık") {
        pool = CACHED_GAMES;
    } else {
        pool = CACHED_GAMES.filter(g => g.tags.includes(category));
    }

    // Yeterli oyun yoksa kalanları diğer kategorilerden doldur
    if (pool.length < 10) {
        const others = CACHED_GAMES.filter(g => !pool.includes(g));
        pool = pool.concat(shuffleArray(others).slice(0, 15 - pool.length));
    }

    // Havuzdan rastgele 10 oyun seç ve hazırla
    const selectedGames = shuffleArray([...pool]).slice(0, 10).map(game => {
        // Her istekte yorumları tekrar karıştır ki aynı oyun gelse bile yorum sırası değişsin
        return {
            ...game,
            reviews: shuffleArray([...game.reviews]).slice(0, 10)
        };
    });

    res.json(selectedGames);
});

app.post('/api/submit-score', async (req, res) => {
    const { username, category, score } = req.body;
    // Basit sunucu tarafı doğrulama
    if (!username || typeof score !== 'number' || score > 10000) { 
        return res.status(400).json({ error: "Geçersiz veri" }); 
    }
    
    const now = Date.now();
    const existingIndex = GLOBAL_SCORES.findIndex(s => s.username === username && s.category === category);
    
    if (existingIndex > -1) {
        GLOBAL_SCORES[existingIndex].timestamp = now;
        if (score > GLOBAL_SCORES[existingIndex].score) {
            GLOBAL_SCORES[existingIndex].score = score;
        }
    } else {
        GLOBAL_SCORES.push({ username, category, score, timestamp: now });
    }
    
    await saveScoresToFile(); // Asenkron kayıt
    res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    const now = Date.now();
    
    // Eski skorları temizle
    GLOBAL_SCORES = GLOBAL_SCORES.filter(s => (now - s.timestamp) < FIVE_DAYS_MS);

    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

app.post('/api/logout', async (req, res) => {
    const { username } = req.body;
    if (username) {
        GLOBAL_SCORES = GLOBAL_SCORES.filter(s => s.username !== username);
        await saveScoresToFile();
    }
    res.json({ success: true });
});

// DOSYA SUNUMU
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/logo.png', (req, res) => { res.sendFile(__dirname + '/logo.png'); });
app.get('/prewiew.jpeg', (req, res) => { res.sendFile(__dirname + '/prewiew.jpeg'); });
app.get('/privacy', (req, res) => { res.sendFile(__dirname + '/privacy.html'); });
app.get('/ads.txt', (req, res) => { res.sendFile(__dirname + '/ads.txt'); });
app.get('/sitemap.xml', (req, res) => { res.sendFile(__dirname + '/sitemap.xml'); });
app.get('/robots.txt', (req, res) => { res.sendFile(__dirname + '/robots.txt'); });

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: Port ${PORT}`);
});