# Kite Proxy Server — Deploy on Railway (Free)

## Setup in 5 minutes

### Step 1 — Zerodha Kite Connect app banana
1. https://developers.kite.trade/signup pe jaao
2. "Create new app" karo
3. Redirect URL mein daalo: `https://YOUR-APP.railway.app/auth/callback`
4. API Key aur API Secret copy karo

### Step 2 — Railway pe deploy karo
1. https://railway.app pe free account banao
2. "New Project" → "Deploy from GitHub repo" OR "Deploy from local"
3. Yeh folder upload karo (`kite-proxy/`)
4. Environment Variables set karo:

```
KITE_API_KEY      = your_api_key_here
KITE_API_SECRET   = your_api_secret_here
KITE_ACCESS_TOKEN = (pehle khali rakh, login ke baad auto-set hoga)
PROXY_SECRET      = koi bhi random string (e.g. "meri-secret-123")
PORT              = 3001
```

### Step 3 — Daily login (ek baar subah 9 baje se pehle)
Kite access token daily expire hota hai. Subah yeh URL open karo:

```
https://YOUR-APP.railway.app/auth/login-url
```

Zerodha login karo → automatic token set ho jaayega.

### Step 4 — v30 app mein proxy URL daalo
App mein Settings → "Kite Proxy URL" mein daalo:
```
https://YOUR-APP.railway.app
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server status check |
| `/auth/login-url` | GET | Zerodha login URL |
| `/auth/callback` | GET | Auto token set (redirect URL) |
| `/auth/status` | GET | Token status check |
| `/quotes?instruments=NSE:NIFTY 50` | GET | Live quotes |
| `/ltp?instruments=NSE:NIFTY 50` | GET | LTP only (faster) |
| `/option-chain?symbol=NIFTY&expiry=2025-05-29&spot=24387` | GET | Full option chain + OI |
| `/candles?instrument=NSE:NIFTY 50&interval=15minute&from=2025-05-01&to=2025-05-22` | GET | Historical OHLCV |
| `/instruments?exchange=NFO&search=NIFTY` | GET | Instrument list |
| `/positions` | GET | Your open positions |
| `/margins` | GET | Available margin |

---

## Expiry date format
Always use `YYYY-MM-DD` format: `2025-05-29`

## Instrument names
- NIFTY 50 index → `NSE:NIFTY 50`
- BANKNIFTY index → `NSE:NIFTY BANK`
- Options → `NFO:NIFTY25MAY24400CE`

---

## Troubleshooting

**CORS error** — proxy sahi deploy nahi hua, Railway URL check karo

**401 Unauthorized** — access token expire ho gaya, `/auth/login-url` se dobara login karo

**404 on option-chain** — expiry date format check karo (YYYY-MM-DD), symbol capital mein hona chahiye

**Rate limits** — Kite personal plan: 3 req/sec, 10k req/day. App mein auto-throttle laga hai.
