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
    
    // Kelime kelime sansür
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

// --- YENİ: AKILLI YORUM FİLTRESİ ---
// Yorumun oyunu gerçekten anlatıp anlatmadığını kontrol eder.
function isDescriptiveReview(text) {
    const t = text.toLowerCase().trim();

    // 1. ÇOK KISA YORUMLARI AT
    // "Çok iyi oyun" gibi yorumlar ipucu vermez. En az 50 karakter olsun.
    if (t.length < 50) return false;
    
    // 2. ÇOK UZUN DESTANLARI AT
    if (t.length > 600) return false;

    // 3. YASAKLI KELİMELER (Siyaset vb.)
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim"];
    for (let f of forbidden) { if (t.includes(f)) return false; }

    // 4. ANAHTAR KELİME KONTROLÜ (EN ÖNEMLİ KISIM)
    // Yorumun içinde oyunla ilgili terimler geçiyor mu?
    const keywords = [
        "hikaye", "grafik", "atmosfer", "mekanik", "oynanış", "bölüm", 
        "karakter", "vuruş", "savaş", "dünya", "yapay zeka", "optimizasyon",
        "görev", "müzik", "ses", "fizik", "bug", "hatası", "server", "hile",
        "arkadaş", "zevk", "sarıyor", "efsane", "anlatım", "sonu"
    ];
    
    // En az 1 tane açıklayıcı kelime geçmeli
    const hasKeyword = keywords.some(kw => t.includes(kw));
    return hasKeyword;
}

// --- API: OYUN İSİMLERİ (AUTOCOMPLETE İÇİN) ---
app.get('/api/all-games', (req, res) => {
    // Sadece isimleri gönderiyoruz, frontend'de arama yapılacak
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

    // Yorum Filtresi: 'all' (Varsayılan olarak en yararlıları getirir) veya 'updated'
    const filterType = 'all'; 

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;

            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            
            // 1. YORUMLARI ÇEK
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=${filterType}&num_per_page=100&purchase_type=all`;
            
            // 2. DETAYLARI ÇEK (İPUCU İÇİN: Yapımcı, Tarih)
            // Not: Bu kısım her oyun için istek atacağı için biraz yavaşlayabilir ama değer.
            // Eğer çok yavaşlarsa client-side'a taşınabilir ama şimdilik backend'de kalsın.
            let metadata = { developer: "Bilinmiyor", date: "Bilinmiyor" };
            
            try {
                // Steam Store API (Rate limit olabilir, hata verirse boş geçeriz)
                // Mağaza sayfasından veri çekmek yerine elimizdeki veriyi kullanıyoruz şimdilik
                // Gerçek API çağrısı sunucuyu yavaşlatabilir.
                // Basitlik için şimdilik sadece yorum ve görsel odaklı gidiyoruz.
                // (İpucu sistemini frontend'de görsel blurlama ile halledeceğiz)
            } catch (e) {
                console.log("Meta veri hatası");
            }

            try {
                const reviewResponse = await axios.get(reviewUrl);
                const reviewsRaw = reviewResponse.data.reviews;

                if (!reviewsRaw || reviewsRaw.length === 0) continue;

                // --- YENİ FİLTRELEME ---
                let validReviews = reviewsRaw
                    .filter(r => isDescriptiveReview(r.review)) // Yeni Akıllı Filtre
                    .map(r => ({
                        text: maskGameName(r.review, game.name),
                        playtime: Math.floor(r.author.playtime_forever / 60),
                        votes: r.votes_up // Yararlılık oyu
                    }));

                // En çok oy alanları öne al, ama sonra kendi içinde karıştır ki hep aynısı gelmesin
                // İlk 20 kaliteli yorumu alıp karıştırıyoruz
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

// ... (Skor Kaydetme ve Liderlik Tablosu kodları AYNI KALIYOR)
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

// Frontend Sunumu
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});
app.get('/logo.png', (req, res) => {
    res.sendFile(__dirname + '/logo.png');
});
app.get('/privacy', (req, res) => {
    res.sendFile(__dirname + '/privacy.html');
});
app.get('/ads.txt', (req, res) => {
    res.sendFile(__dirname + '/ads.txt');
});
app.get('/sitemap.xml', (req, res) => {
    res.sendFile(__dirname + '/sitemap.xml');
});
app.get('/robots.txt', (req, res) => {
    res.sendFile(__dirname + '/robots.txt');
});

app.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: Port ${PORT}`);
});