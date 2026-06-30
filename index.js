const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, Stochastic, StochasticRSI } = require('technicalindicators');
const express = require('express');

// --- AYARLAR ---
// LÜTFEN YENİ ALDIĞINIZ TOKENI BURAYA YAZIN
const TELEGRAM_TOKEN = '8370906073:AAEMKcOeONWrFM0x5WCWeBZKVqmCRbaxy20'; 
const CHAT_ID = '6824522530';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

const MAX_AGE_DAYS = 5; 
const TIMEFRAME_MINUTES = 3; // 3 dakikalık mumlar

// Render'ı uyanık tutmak için web sunucusu
const app = express();
app.get('/', (req, res) => res.send('DexBot is running!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

// Tarih kontrolü
function isNewCoin(pairCreatedAt) {
    if (!pairCreatedAt) return false;
    const ageInMs = Date.now() - pairCreatedAt;
    const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
    return ageInDays <= MAX_AGE_DAYS;
}

// Mum verilerini çekme (GeckoTerminal API)
async function getCandles(network, poolAddress) {
    try {
        // GeckoTerminal API: network (örn: solana), havuz adresi, ohlcv/minute, aggregate=3 (3 dakikalık)
        const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/minute?aggregate=${TIMEFRAME_MINUTES}&limit=100`;
        const response = await axios.get(url);
        
        const ohlcv = response.data.data.attributes.ohlcv_list;
        
        // API veriyi Yeniden-Eskiye (newest to oldest) veriyor. İndikatörler Eskiden-Yeniye (oldest to newest) ister.
        ohlcv.reverse(); 

        const highs = [];
        const lows = [];
        const closes = [];

        for (let i = 0; i < ohlcv.length; i++) {
            highs.push(ohlcv[i][2]); // High
            lows.push(ohlcv[i][3]);  // Low
            closes.push(ohlcv[i][4]); // Close
        }

        return { highs, lows, closes };
    } catch (error) {
        // API limitlerine takılmamak için hataları yutuyoruz
        return null;
    }
}

// Analiz Fonksiyonu
async function analyzePair(pair) {
    try {
        // Ağ adını GeckoTerminal formatına çevir
        let network = pair.chainId.toLowerCase();
        
        const candleData = await getCandles(network, pair.pairAddress);
        
        if (!candleData || candleData.closes.length < 50) return; // Yeterli mum yoksa çık

        const { highs, lows, closes } = candleData;

        // 1. ŞART: RSI (14) < 20
        const rsiValues = RSI.calculate({ period: 14, values: closes });
        const lastRsi = rsiValues[rsiValues.length - 1];

        // 2. ŞART: Stoch 1 (40, 9, 4) - Sadece K < 10
        const stoch1 = Stochastic.calculate({
            high: highs, low: lows, close: closes,
            period: 40, signalPeriod: 4 
        });
        const lastStoch1K = stoch1[stoch1.length - 1].k;

        // 3. ŞART: Stoch 2 (9, 3, 3) - Sadece K < 10
        const stoch2 = Stochastic.calculate({
            high: highs, low: lows, close: closes,
            period: 9, signalPeriod: 3
        });
        const lastStoch2K = stoch2[stoch2.length - 1].k;

        // 4. ŞART: StochRSI (1, 3, 14, 14) - D çizgisi 0'a değmeli (0 veya 0'a çok yakın)
        const stochRsi = StochasticRSI.calculate({
            values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 1, dPeriod: 3
        });
        const lastStochRsiD = stochRsi[stochRsi.length - 1].stochRSI;

        // --- SİNYAL KOŞULLARI ---
        if (
            lastRsi < 30 &&
            lastStoch1K < 20 &&
            lastStoch2K < 20 &&
            lastStochRsiD <= 0.01 // Tam 0 matematiksel olarak nadir yakalanır, 0.01 altı 0'a değmiş kabul edilir
        ) {
            const message = `
🟢 <b>YENİ ALIM SİNYALİ (3m)</b> 🟢
🪙 Coin: ${pair.baseToken.symbol} / ${pair.quoteToken.symbol}
💵 Fiyat: $${pair.priceUsd}
⏳ Havuz Yaşı: Yeni

📊 <b>İndikatör Değerleri:</b>
- RSI: ${lastRsi.toFixed(2)}
- Stoch(40) K: ${lastStoch1K.toFixed(2)}
- Stoch(9) K: ${lastStoch2K.toFixed(2)}
- StochRSI D: ${lastStochRsiD.toFixed(2)}

🔗 <a href="${pair.url}">Dexscreener'da İncele</a>
            `;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true });
            console.log(`🚨 Sinyal Gönderildi: ${pair.baseToken.symbol}`);
        }

    } catch (error) {
        // Hata loglarını kapatıyoruz, terminal kalabalık olmasın
    }
}

// Ana Tarama Döngüsü
async function startScanner() {
    console.log("🚀 Tarayıcı başlatıldı! Sinyal bekleniyor...");
    
    // API hız limitlerini aşmamak için taramayı 3 dakikada bir çalıştırır
    setInterval(async () => {
        try {
            console.log("Dexscreener taranıyor...");
            // Solana ağındaki en yeni tokenları çekiyoruz
            const response = await axios.get('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
            const pairs = response.data.pairs;

            if (pairs) {
                // API çok hızlı istek atıp banlanmamak için tokenları sırayla yavaş yavaş kontrol ediyoruz
                for (let i = 0; i < pairs.length; i++) {
                    const pair = pairs[i];
                    if (isNewCoin(pair.pairCreatedAt)) {
                        await analyzePair(pair);
                        // Her coin analizi arasına 1 saniye bekleme süresi koyduk (API block yememek için)
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        } catch (error) {
            console.error("Tarama hatası, bir sonraki döngü bekleniyor...");
        }
    }, 3 * 60 * 1000); // Her 3 dakikada bir çalışır
}

// Sistemi Başlat
startScanner();
