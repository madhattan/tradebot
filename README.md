# 🤖 Solana AI TradeBot

En avancerad, självlärd sniping- och autotrade-bot byggd för Solana. Den lyssnar på nya token-lanseringar (t.ex. via Raydium), utvärderar dem i realtid, och handlar automatiskt baserat på prisrörelser, volym, holders och risksignaler.

---

## 🚀 Funktioner

- Lyssnar på `initialize2`-instruktionen för att upptäcka nya pools  
- Integrering med **Jupiter**, **Dexscreener**, **Raydium**, och **Shyft API**  
- Automatisk köp/sälj-logik med:
  - ✅ Dynamisk Take-Profit  
  - ✅ Trailing Stop-Loss  
  - ✅ Rug Pull-detektion  
  - ✅ Buy/Sell-ratio-analys  
  - ✅ Holder-analys  
- Loggar alla trades (köp, sälj, PnL) i `trade_log.txt`

---

## 📦 Teknisk stack

- Node.js  
- @solana/web3.js  
- Raydium SDK  
- dotenv, bs58, node-fetch, fs

---

## 🔧 Installation

```bash
git clone https://github.com/dittnamn/solana-tradebot.git
cd solana-tradebot
npm install
```

---

## 🔐 Skapa `.env`-fil

```env
PRIVATE_KEY=din_base58_nyckel
RPC_URL=https://din.rpc.url
WSS_URL=wss://din.wss.url
SHYFT_API_KEY=din_shyft_api_key
```

---

## ▶️ Starta boten

```bash
node index.js
```

---

## 📊 Trade-loggexempel

```
2025-06-16T10:21:00Z | BUY | CA: 9abc...xyz | Amount: 0.25 SOL | Price: 0.000042 SOL | TX: ...
2025-06-16T10:23:30Z | SELL | CA: 9abc...xyz | Amount: 0.25 SOL | Price: 0.000089 SOL | TX: ... | PnL: +0.0118 SOL
```

---

## 💡 Funktionell logik

- **Stop-Loss** sätts initialt till 70% av inköpspriset  
- **Break-even** flyttas upp efter 1.3x prisökning  
- **Take-Profit** anpassas beroende på pumpspeed i senaste 60 sekunderna  
- Tokens som faller >70% från ATH säljs direkt (rug-pull-skydd)  
- Tokens med låg volym, inaktivitet eller onormala holder-mönster flaggas och ignoreras  

---

## 📁 Filstruktur

```
├── index.js                # Huvudfil
├── trade_log.txt           # Loggfil för trades
├── rugged_tokens.json      # Blockerade tokens
├── .env                    # Dold miljökonfig (läggs ej upp på GitHub)
```

---

## ⚠️ Ansvarsfriskrivning

> Detta projekt är en **hobbybot**. Inga garantier ges för vinst, säkerhet eller funktion. Använd på egen risk.

---

## 🙋‍♂️ Om utvecklaren

Jag är en självlärd utvecklare med bakgrund inom el, skog, service och AI/automatisering. Jag gillar att bygga verkliga projekt som löser riktiga problem – och detta är ett exempel på just det.

---

## 📄 Licens

MIT License
