// ─────────────────────────────────────────────────────────────
//  Kite Connect Proxy Server  —  v1.0
//  Deploy free on Railway / Render / Fly.io
//  github.com/zerodha/kiteconnectjs for reference
// ─────────────────────────────────────────────────────────────
const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const app     = express();

app.use(cors({ origin: "*" }));           // allow your JSX app
app.use(express.json());

// ── CONFIG — set these as environment variables on Railway ──
const API_KEY      = process.env.KITE_API_KEY    || "";
const API_SECRET   = process.env.KITE_API_SECRET || "";
const KITE_BASE    = "https://api.kite.trade";

// In-memory token store (refreshes on login)
let ACCESS_TOKEN   = process.env.KITE_ACCESS_TOKEN || "";
let tokenFetchedAt = 0;

// ── helper: Kite auth headers ──
const kiteHeaders = () => ({
  "X-Kite-Version": "3",
  "Authorization": `token ${API_KEY}:${ACCESS_TOKEN}`,
  "Content-Type": "application/x-www-form-urlencoded",
});

// ─────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────────

// Step 1 — frontend redirects user to this URL for login
app.get("/auth/login-url", (req, res) => {
  res.json({
    url: `https://kite.zerodha.com/connect/login?api_key=${API_KEY}&v=3`
  });
});

// Step 2 — Zerodha redirects back here with ?request_token=xxx
// Kite connect app's redirect URL must be: https://your-proxy.railway.app/auth/callback
app.get("/auth/callback", async (req, res) => {
  const { request_token } = req.query;
  if (!request_token) return res.status(400).json({ error: "No request token" });

  try {
    const crypto = require("crypto");
    const checksum = crypto
      .createHash("sha256")
      .update(API_KEY + request_token + API_SECRET)
      .digest("hex");

    const resp = await axios.post(
      `${KITE_BASE}/session/token`,
      new URLSearchParams({
        api_key:       API_KEY,
        request_token,
        checksum,
      }).toString(),
      { headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" } }
    );

    ACCESS_TOKEN   = resp.data.data.access_token;
    tokenFetchedAt = Date.now();

    // Redirect back to app with token in hash (never in query for security)
    res.redirect(`/?access_token=${ACCESS_TOKEN}`);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Set token manually (useful if you generate token externally each morning)
app.post("/auth/set-token", (req, res) => {
  const { access_token, secret } = req.body;
  if (secret !== process.env.PROXY_SECRET) return res.status(403).json({ error: "Bad secret" });
  ACCESS_TOKEN   = access_token;
  tokenFetchedAt = Date.now();
  res.json({ ok: true, message: "Token set successfully" });
});

app.get("/auth/status", (req, res) => {
  res.json({
    authenticated: !!ACCESS_TOKEN,
    tokenAge: ACCESS_TOKEN ? Math.round((Date.now() - tokenFetchedAt) / 60000) + " min" : null
  });
});

// ─────────────────────────────────────────────────────────────
//  QUOTES  (live LTP + OHLC for any instrument)
// ─────────────────────────────────────────────────────────────
// GET /quotes?instruments=NSE:NIFTY+50,NSE:BANKNIFTY,...
app.get("/quotes", async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) return res.status(400).json({ error: "instruments param required" });
  try {
    const r = await axios.get(`${KITE_BASE}/quote`, {
      params: { i: instruments.split(",") },
      headers: kiteHeaders(),
    });
    res.json(r.data.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// GET /ltp?instruments=NSE:NIFTY+50
app.get("/ltp", async (req, res) => {
  const { instruments } = req.query;
  try {
    const r = await axios.get(`${KITE_BASE}/quote/ltp`, {
      params: { i: instruments.split(",") },
      headers: kiteHeaders(),
    });
    res.json(r.data.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  OPTION CHAIN  (OI + LTP for all strikes of one expiry)
// ─────────────────────────────────────────────────────────────
// GET /option-chain?symbol=NIFTY&expiry=2025-05-29&spot=24387
app.get("/option-chain", async (req, res) => {
  const { symbol = "NIFTY", expiry, spot } = req.query;
  if (!expiry) return res.status(400).json({ error: "expiry required (YYYY-MM-DD)" });

  try {
    // 1. Get full instruments dump (cached — huge file, ~4 MB)
    const instrResp = await axios.get(`${KITE_BASE}/instruments/NFO`, {
      headers: { "X-Kite-Version": "3" }
    });

    // Parse CSV
    const lines   = instrResp.data.trim().split("\n");
    const headers = lines[0].split(",");
    const idx     = (k) => headers.indexOf(k);

    const instruments = lines.slice(1)
      .map(l => l.split(","))
      .filter(cols =>
        cols[idx("name")]      === symbol &&
        cols[idx("expiry")]    === expiry &&
        cols[idx("segment")]   === "NFO-OPT"
      )
      .map(cols => ({
        token:      cols[idx("instrument_token")],
        tradingsym: cols[idx("tradingsymbol")],
        strike:     parseFloat(cols[idx("strike")]),
        type:       cols[idx("instrument_type")],   // CE / PE
        lot:        parseInt(cols[idx("lot_size")]),
        expiry:     cols[idx("expiry")],
      }));

    if (!instruments.length)
      return res.status(404).json({ error: `No instruments found for ${symbol} expiry ${expiry}` });

    // 2. Fetch quotes in batches of 500
    const BATCH = 500;
    const tokens = instruments.map(i => `NFO:${i.tradingsym}`);
    let quoteData = {};
    for (let b = 0; b < tokens.length; b += BATCH) {
      const r = await axios.get(`${KITE_BASE}/quote`, {
        params: { i: tokens.slice(b, b + BATCH) },
        headers: kiteHeaders(),
      });
      Object.assign(quoteData, r.data.data);
    }

    // 3. Build chain structure
    const spotPrice = parseFloat(spot) || 0;
    const step      = symbol === "BANKNIFTY" ? 100 : symbol === "SENSEX" ? 200 : 50;
    const atm       = Math.round(spotPrice / step) * step;

    const chain = {};
    instruments.forEach(inst => {
      const key = inst.strike;
      if (!chain[key]) chain[key] = { strike: key, isATM: key === atm };
      const q = quoteData[`NFO:${inst.tradingsym}`] || {};
      const side = inst.type === "CE" ? "ce" : "pe";
      chain[key][side] = {
        ltp:        q.last_price             || 0,
        oi:         q.oi                     || 0,
        oiChange:   q.oi_day_high            || 0,  // proxy for OI change
        volume:     q.volume                 || 0,
        iv:         q.Greeks?.iv             || 0,
        delta:      q.Greeks?.delta          || 0,
        theta:      q.Greeks?.theta          || 0,
        vega:       q.Greeks?.vega           || 0,
        gamma:      q.Greeks?.gamma          || 0,
        bid:        q.depth?.buy?.[0]?.price || 0,
        ask:        q.depth?.sell?.[0]?.price|| 0,
        ohlc:       q.ohlc                   || {},
        token:      inst.token,
        tradingsym: inst.tradingsym,
        lot:        inst.lot,
      };
    });

    // Sort by strike
    const chainArr = Object.values(chain).sort((a, b) => a.strike - b.strike);

    // Summary stats
    const totalCeOI = chainArr.reduce((s, r) => s + (r.ce?.oi || 0), 0);
    const totalPeOI = chainArr.reduce((s, r) => s + (r.pe?.oi || 0), 0);
    const pcr       = totalCeOI > 0 ? (totalPeOI / totalCeOI).toFixed(2) : "—";

    // Max pain
    let maxPainStrike = atm, maxPainLoss = Infinity;
    chainArr.forEach(row => {
      const loss = chainArr.reduce((sum, r) => {
        const ceLoss = r.ce ? Math.max(0, r.strike - row.strike) * (r.ce.oi || 0) : 0;
        const peLoss = r.pe ? Math.max(0, row.strike - r.strike) * (r.pe.oi || 0) : 0;
        return sum + ceLoss + peLoss;
      }, 0);
      if (loss < maxPainLoss) { maxPainLoss = loss; maxPainStrike = row.strike; }
    });

    res.json({
      symbol, expiry, spot: spotPrice, atm, step, pcr,
      maxPain: maxPainStrike,
      totalCeOI, totalPeOI,
      chain: chainArr,
      fetchedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error(e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  HISTORICAL CANDLES
// ─────────────────────────────────────────────────────────────
// GET /candles?instrument=NSE:NIFTY+50&interval=15minute&from=2025-05-01&to=2025-05-22
// intervals: minute, 3minute, 5minute, 15minute, 30minute, 60minute, day
app.get("/candles", async (req, res) => {
  const { instrument, interval = "15minute", from, to } = req.query;
  if (!instrument || !from || !to)
    return res.status(400).json({ error: "instrument, from, to required" });

  try {
    // Need instrument token — fetch from instruments list
    const instrResp = await axios.get(`${KITE_BASE}/instruments/NSE`, {
      headers: { "X-Kite-Version": "3" }
    });
    const lines   = instrResp.data.trim().split("\n");
    const headers = lines[0].split(",");
    const idx     = (k) => headers.indexOf(k);
    const sym     = instrument.replace("NSE:", "");
    const found   = lines.slice(1).map(l => l.split(","))
      .find(c => c[idx("tradingsymbol")] === sym);

    if (!found) return res.status(404).json({ error: `Symbol ${sym} not found` });
    const token = found[idx("instrument_token")];

    const r = await axios.get(
      `${KITE_BASE}/instruments/historical/${token}/${interval}`,
      {
        params: { from, to, continuous: 0, oi: 0 },
        headers: kiteHeaders(),
      }
    );

    const candles = (r.data.data?.candles || []).map(c => ({
      date: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
    }));

    res.json({ instrument, interval, candles, count: candles.length });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  INSTRUMENTS LIST  (for autocomplete / token lookup)
// ─────────────────────────────────────────────────────────────
app.get("/instruments", async (req, res) => {
  const { exchange = "NFO", search } = req.query;
  try {
    const r = await axios.get(`${KITE_BASE}/instruments/${exchange}`, {
      headers: { "X-Kite-Version": "3" }
    });
    const lines   = r.data.trim().split("\n");
    const headers = lines[0].split(",");
    const idx     = (k) => headers.indexOf(k);
    let instruments = lines.slice(1).map(l => {
      const c = l.split(",");
      return {
        token:  c[idx("instrument_token")],
        symbol: c[idx("tradingsymbol")],
        name:   c[idx("name")],
        expiry: c[idx("expiry")],
        strike: c[idx("strike")],
        type:   c[idx("instrument_type")],
        lot:    c[idx("lot_size")],
      };
    });
    if (search) instruments = instruments.filter(i => i.symbol.includes(search.toUpperCase()));
    res.json(instruments.slice(0, 500));
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  PORTFOLIO  (positions + holdings)
// ─────────────────────────────────────────────────────────────
app.get("/positions", async (req, res) => {
  try {
    const r = await axios.get(`${KITE_BASE}/portfolio/positions`, { headers: kiteHeaders() });
    res.json(r.data.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

app.get("/margins", async (req, res) => {
  try {
    const r = await axios.get(`${KITE_BASE}/user/margins/commodity`, { headers: kiteHeaders() });
    res.json(r.data.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0",
    authenticated: !!ACCESS_TOKEN,
    uptime: process.uptime().toFixed(0) + "s",
    time: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Kite proxy running on port ${PORT}`));
