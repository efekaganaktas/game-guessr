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
let GLOBAL_SCORES = [];

// --- YARDIMCI FONKSİYONLAR ---

// Oyun ismini sansürle
function maskGameName(text, gameName) {
    const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let masked = text.replace(new RegExp(escapeRegExp(gameName), 'gi'), '***');
    
    // Oyun isminin parçalarını da sansürle (Örn: "Half-Life 2" için "Half", "Life"...)
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

// Temel kalite kontrolü (Siyaset, küfür, anlamsız karakterler)
function isSafeContent(text) {
    const t = text.toLowerCase().trim();
    
    // Siyaset ve ağır spam filtresi
    const forbidden = ["recep tayyip", "rte", "siyaset", "seçim", "cumhurbaşkanı", "kurdistan", "terör"];
    for (let f of forbidden) { if (t.includes(f)) return false; }
    
    // Çok çok kısa (tek kelime küfür vb.) veya aşırı uzun (spam) ise ele
    if (t.length > 600) return false; // Okuması zor olmasın diye limiti biraz artırdım ama çok da değil
    if (t.length < 5) return false;   // "güzel" gibi tek kelimelikleri tutabiliriz ama 5 harf altı genelde çöp
    
    // Sadece şekil/ascii art olan yorumları ele (basit kontrol)
    const letterCount = (t.match(/[a-zğüşıöç]/g) || []).length;
    if (letterCount < 3) return false;

    return true;
}

// --- API ENDPOINTLERİ ---

// 1. Oyun İsimlerini Getir
app.get('/api/all-games', (req, res) => {
    const names = GAME_IDS.map(g => g.name);
    res.json(names);
});

// 2. Oyun Sorusu Getir (GÜNCELLENEN KISIM)
app.get('/api/game-quiz', async (req, res) => {
    const category = req.query.category;
    let pool = [];

    if (!category || category === "Tümü" || category === "Karışık") {
        pool = GAME_IDS;
    } else {
        pool = GAME_IDS.filter(g => g.tags.includes(category));
    }

    // Yeterli oyun yoksa havuzu diğerleriyle doldur
    if (pool.length < 10) {
        const others = GAME_IDS.filter(g => !pool.includes(g));
        pool = pool.concat(shuffleArray(others).slice(0, 15 - pool.length));
    }

    const shuffledGames = shuffleArray([...pool]); 
    const resultData = [];
    const MAX_GAMES = 10; // İstemciye gönderilecek toplam oyun sayısı

    try {
        for (let game of shuffledGames) {
            if (resultData.length >= MAX_GAMES) break;

            const imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.id}/header.jpg`;
            // DAHA FAZLA YORUM ÇEKİYORUZ (num_per_page=100)
            const reviewUrl = `https://store.steampowered.com/appreviews/${game.id}?json=1&language=turkish&filter=all&num_per_page=100&purchase_type=all`;
            
            // Oyun Detaylarını Çek
            let gameDetails = { developer: "Bilinmiyor", date: "?", likes: "0" };
            try {
                const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${game.id}&l=turkish`;
                const detailRes = await axios.get(detailsUrl);
                if(detailRes.data && detailRes.data[game.id] && detailRes.data[game.id].success) {
                    const data = detailRes.data[game.id].data;
                    gameDetails = {
                        developer: data.developers ? data.developers[0] : "Bilinmiyor",
                        date: data.release_date ? data.release_date.date : "?",
                        likes: data.recommendations ? data.recommendations.total.toLocaleString() : "0"
                    };
                }
            } catch (detailErr) { /* Detay çekilemezse varsayılan kalır */ }

            try {
                const reviewResponse = await axios.get(reviewUrl);
                let reviewsRaw = reviewResponse.data.reviews;

                if (!reviewsRaw || reviewsRaw.length < 5) continue; // Çok az yorumu olan oyunu pas geç

                // 1. ADIM: Güvenlik Filtresi (Siyaset/Spam temizliği)
                let safeReviews = reviewsRaw.filter(r => isSafeContent(r.review));

                // 2. ADIM: Kategorizasyon
                // Bilgilendirici: Uzunluğu makul, genelde oyun hakkında bilgi verir.
                // Eğlenceli/Kısa: Kısa ama yüksek puan almış olabilir.
                
                let informativeReviews = [];
                let funnyReviews = [];
                let fillerReviews = [];

                safeReviews.forEach(r => {
                    const cleanText = r.review.replace(/\r\n/g, " ").trim();
                    const item = {
                        text: maskGameName(cleanText, game.name),
                        playtime: Math.floor(r.author.playtime_forever / 60),
                        votes: r.votes_up // Yararlılık puanı
                    };

                    // İngilizce filtresi (Basit)
                    const commonEnglish = [" the ", " is ", " and ", " game ", " best ", " good "];
                    let enCount = 0;
                    for(let w of commonEnglish) { if(item.text.toLowerCase().includes(w)) enCount++; }
                    if (enCount >= 3) return; // İngilizce yorumu atla

                    if (item.text.length > 60) {
                        informativeReviews.push(item);
                    } else if (item.text.length <= 60 && item.text.length > 5) {
                        funnyReviews.push(item);
                    } else {
                        fillerReviews.push(item);
                    }
                });

                // Yararlılık puanına göre sırala (En beğenilenler üstte)
                informativeReviews.sort((a, b) => b.votes - a.votes);
                funnyReviews.sort((a, b) => b.votes - a.votes);

                // 3. ADIM: 10 Adet Yorum Oluşturma (Karma Strateji)
                let finalReviews = [];

                // A) Önce 7-8 tane bilgilendirici (tahmin ettirici) al
                finalReviews.push(...informativeReviews.slice(0, 8));

                // B) Sonra 2-3 tane kısa/komik al (Renk katsın)
                const neededForFun = 10 - finalReviews.length;
                finalReviews.push(...funnyReviews.slice(0, Math.min(neededForFun, 3))); // En fazla 3 komik

                // C) Eğer hala 10 tane olmadıysa, ne bulursan ekle (Filler veya artan informative)
                while (finalReviews.length < 10) {
                    // Kullanılmamış informative var mı?
                    if (informativeReviews.length > 8 + (finalReviews.length - neededForFun)) {
                         // Basitçe: Kalan havuzdan ekle (Burada indeks takibi karmaşıklaşmasın diye basitleştiriyorum)
                         // Rastgele kalanlardan al
                         let nextCandidate = informativeReviews[finalReviews.length] || funnyReviews[finalReviews.length] || fillerReviews[0];
                         if (nextCandidate && !finalReviews.includes(nextCandidate)) {
                             finalReviews.push(nextCandidate);
                         } else {
                             // Havuz tamamen kuruduysa döngüyü kır (ama 100 yorum çektiğimiz için zor)
                             break;
                         }
                    } else {
                        // Hiçbir şey kalmadıysa, listeyi doldurmak için başa dönüp tekrar ekle (Son çare)
                        if (finalReviews.length > 0) {
                            finalReviews.push(finalReviews[0]); 
                        } else {
                            break; 
                        }
                    }
                }

                // Yorumları karıştır (Komikler hep sonda olmasın)
                finalReviews = shuffleArray(finalReviews);

                // Eğer hala 3 yorumdan az ise bu oyunu tamamen pas geç
                if (finalReviews.length < 3) continue;

                resultData.push({
                    id: game.id,
                    name: game.name,
                    category: game.tags.join(', '),
                    image: imageUrl,
                    details: gameDetails,
                    reviews: finalReviews.slice(0, 10) // Ne olursa olsun maksimum 10 gönder
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
    res.json({ success: true });
});

// 4. Liderlik Tablosu
app.get('/api/leaderboard', (req, res) => {
    const category = req.query.category;
    const now = Date.now();
    GLOBAL_SCORES = GLOBAL_SCORES.filter(s => (now - s.timestamp) < FIVE_DAYS_MS);

    let currentScores = [...GLOBAL_SCORES];
    if (category) currentScores = currentScores.filter(s => s.category === category);
    
    currentScores.sort((a, b) => b.score - a.score);
    res.json(currentScores.slice(0, 10));
});

// 5. Çıkış Yap
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