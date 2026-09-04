
import time
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import streamlit as st
import plotly.graph_objects as go

BINANCE = "https://fapi.binance.com"
CONFIG = Path(__file__).with_name("config.json")

st.set_page_config(page_title="BSM — Bull/Bear Synchronization Monitor", page_icon="📡", layout="wide")

DEFAULT_UNIVERSE = [
    "STXUSDT","BABYUSDT","COREUSDT","RUNEUSDT","TUSDT","SOLVUSDT",
    "PSTAKEUSDT","SOVUSDT","MERLUSDT","BOBUSDT","BTRUSDT","FBUSDT",
    "CWEBUSDT","ELAUSDT","TETUSDT","VELARUSDT","PTBUSDT"
]

def load_config():
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text())
        except Exception:
            pass
    return {
        "symbols": DEFAULT_UNIVERSE,
        "interval": "15m",
        "lookback": 120,
        "refresh_seconds": 30,
        "signal_threshold": 70,
        "hot_candle_pct": 2.0,
        "reversal_target_pct": 2.0
    }

cfg = load_config()

@st.cache_data(ttl=300)
def exchange_symbols():
    r = requests.get(f"{BINANCE}/fapi/v1/exchangeInfo", timeout=10)
    r.raise_for_status()
    data = r.json()
    return {
        x["symbol"] for x in data["symbols"]
        if x.get("status") == "TRADING" and x.get("contractType") == "PERPETUAL"
        and x.get("quoteAsset") == "USDT"
    }

def get_json(path, params=None):
    r = requests.get(BINANCE + path, params=params, timeout=10)
    r.raise_for_status()
    return r.json()

@st.cache_data(ttl=20)
def klines(symbol, interval, limit):
    rows = get_json("/fapi/v1/klines", {"symbol": symbol, "interval": interval, "limit": limit})
    df = pd.DataFrame(rows, columns=[
        "open_time","open","high","low","close","volume","close_time",
        "quote_volume","trades","taker_buy_base","taker_buy_quote","ignore"
    ])
    for c in ["open","high","low","close","volume","quote_volume","taker_buy_base","taker_buy_quote"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    return df

@st.cache_data(ttl=30)
def funding(symbol):
    try:
        x = get_json("/fapi/v1/premiumIndex", {"symbol": symbol})
        return float(x.get("lastFundingRate", 0)) * 100
    except Exception:
        return np.nan

@st.cache_data(ttl=30)
def open_interest(symbol):
    try:
        x = get_json("/fapi/v1/openInterest", {"symbol": symbol})
        return float(x["openInterest"])
    except Exception:
        return np.nan

@st.cache_data(ttl=30)
def mark_price(symbol):
    try:
        x = get_json("/fapi/v1/premiumIndex", {"symbol": symbol})
        return float(x["markPrice"])
    except Exception:
        return np.nan

def pct(a, b):
    return (a / b - 1) * 100 if b else 0

def features(symbol):
    df = klines(symbol, cfg["interval"], cfg["lookback"]).copy()
    if len(df) < 30:
        raise ValueError("Not enough candles")

    # Use completed candles for the ranking engine.
    d = df.iloc[:-1].copy()
    last = d.iloc[-1]
    prev = d.iloc[-2]

    d["ema7"] = d.close.ewm(span=7, adjust=False).mean()
    d["ema25"] = d.close.ewm(span=25, adjust=False).mean()
    d["ema99"] = d.close.ewm(span=99, adjust=False).mean()
    d["ret"] = d.close.pct_change() * 100
    d["range_pct"] = (d.high / d.low - 1) * 100
    d["body_pct"] = (d.close / d.open - 1) * 100
    d["vol_ma20"] = d.volume.rolling(20).mean()
    d["vol_ratio"] = d.volume / d.vol_ma20

    body = float(last["body_pct"])
    range_pct = float(last["range_pct"])
    vol_ratio = float(last["vol_ratio"]) if pd.notna(last["vol_ratio"]) else 1
    ema7, ema25, ema99 = float(last["ema7"]), float(last["ema25"]), float(last["ema99"])

    # A reversal-oriented score: 100 is strongest bearish exhaustion candidate.
    score = 0.0
    reasons = []

    if body <= -cfg["hot_candle_pct"]:
        score += 25
        reasons.append(f"hot bearish candle {body:.2f}%")
    elif body <= -1:
        score += 12
        reasons.append(f"bearish candle {body:.2f}%")

    if vol_ratio >= 2:
        score += 20
        reasons.append(f"volume {vol_ratio:.1f}x")
    elif vol_ratio >= 1.4:
        score += 10
        reasons.append(f"volume {vol_ratio:.1f}x")

    if last.close < ema7:
        score += 10
        reasons.append("below EMA7")
    if last.close < ema25:
        score += 10
        reasons.append("below EMA25")
    if ema7 < ema25:
        score += 8
        reasons.append("EMA7<EMA25")

    # Short-term extension below the recent 20-candle mean.
    mean20 = d.close.rolling(20).mean().iloc[-1]
    extension = pct(last.close, mean20)
    if extension <= -3:
        score += 12
        reasons.append(f"extended {extension:.1f}%")

    # A strong upper/lower wick pattern can indicate rejection.
    lower_wick = min(last.open, last.close) - last.low
    upper_wick = last.high - max(last.open, last.close)
    if lower_wick > abs(last.close-last.open) * 1.5 and lower_wick > 0:
        score -= 8
        reasons.append("lower-wick rejection")

    # Recent acceleration.
    r3 = pct(last.close, d.close.iloc[-4])
    if r3 <= -5:
        score += 10
        reasons.append(f"3-candle drop {r3:.1f}%")

    return {
        "symbol": symbol,
        "price": float(last.close),
        "body_pct": body,
        "range_pct": range_pct,
        "vol_ratio": vol_ratio,
        "funding": funding(symbol),
        "oi": open_interest(symbol),
        "mark": mark_price(symbol),
        "ema7": ema7,
        "ema25": ema25,
        "ema99": ema99,
        "extension": extension,
        "score_raw": max(0, min(100, score)),
        "reasons": reasons,
        "df": df
    }

def apply_market_context(rows):
    if not rows:
        return rows
    bearish = sum(1 for r in rows if r["body_pct"] < 0)
    bullish = len(rows) - bearish
    sync = bearish / len(rows) * 100
    for r in rows:
        # Synchronized selloff boosts reversal candidates; synchronized rally
        # boosts the warning side of the monitor but does not create a long signal.
        r["sync_bearish_pct"] = sync
        if sync >= 70 and r["body_pct"] <= -1:
            r["score"] = min(100, r["score_raw"] + 10)
        else:
            r["score"] = r["score_raw"]
        r["signal"] = (
            "REVERSAL WATCH" if r["score"] >= cfg["signal_threshold"] and sync >= 55
            else "WATCH" if r["score"] >= 45
            else "NO SIGNAL"
        )
    return rows

def notify_local(title, message):
    # Optional desktop notification. Failure is harmless.
    try:
        from plyer import notification
        notification.notify(title=title, message=message, timeout=8)
    except Exception:
        pass

st.title("📡 BSM — Bull/Bear Synchronization Monitor")
st.caption("Market intelligence only • Public Binance data • No API keys • No order execution • BSM alerts, you decide.")

with st.sidebar:
    st.header("Engine")
    interval = st.selectbox("Timeframe", ["1m","3m","5m","15m","30m","1h"], index=["1m","3m","5m","15m","30m","1h"].index(cfg["interval"]))
    cfg["interval"] = interval
    threshold = st.slider("Signal threshold", 40, 90, int(cfg["signal_threshold"]))
    cfg["signal_threshold"] = threshold
    hot = st.number_input("Hot bearish candle (%)", 0.5, 10.0, float(cfg["hot_candle_pct"]), 0.5)
    cfg["hot_candle_pct"] = hot
    refresh = st.slider("Refresh seconds", 10, 300, int(cfg["refresh_seconds"]), 10)
    cfg["refresh_seconds"] = refresh
    st.divider()
    st.write("Universe")
    st.code(", ".join(cfg["symbols"]), language="text")
    st.info("Edit config.json to add/remove symbols. Invalid or unavailable contracts are skipped automatically.")
    if st.button("Refresh now"):
        st.cache_data.clear()
        st.rerun()

try:
    available = exchange_symbols()
except Exception as e:
    st.error(f"Cannot reach Binance public market data: {e}")
    st.stop()

symbols = [s for s in cfg["symbols"] if s in available]
missing = [s for s in cfg["symbols"] if s not in available]
if missing:
    st.warning("Skipped unavailable symbols: " + ", ".join(missing))

rows, errors = [], []
progress = st.progress(0)
for i, symbol in enumerate(symbols):
    try:
        rows.append(features(symbol))
    except Exception as e:
        errors.append(f"{symbol}: {e}")
    progress.progress((i+1)/max(1,len(symbols)))
progress.empty()

rows = apply_market_context(rows)
rows.sort(key=lambda x: x.get("score", 0), reverse=True)

if not rows:
    st.error("No symbols could be analyzed.")
    st.stop()

sync = rows[0]["sync_bearish_pct"]
c1,c2,c3,c4 = st.columns(4)
c1.metric("Coins monitored", len(rows))
c2.metric("Bearish together", f"{sync:.0f}%")
c3.metric("Reversal watches", sum(r["signal"]=="REVERSAL WATCH" for r in rows))
c4.metric("Refresh", f"{refresh}s")

st.subheader("Live ranking")
table = pd.DataFrame([{
    "Rank": i+1,
    "Coin": r["symbol"].replace("USDT",""),
    "Signal": r["signal"],
    "Score": round(r["score"],1),
    f"{interval} body %": round(r["body_pct"],2),
    "Volume ×": round(r["vol_ratio"],2),
    "Funding %": round(r["funding"],4) if pd.notna(r["funding"]) else None,
    "OI": round(r["oi"],2) if pd.notna(r["oi"]) else None,
    "EMA7": r["ema7"],
    "EMA25": r["ema25"],
    "Price": r["price"]
} for i,r in enumerate(rows)])
st.dataframe(table, use_container_width=True, hide_index=True)

signals = [r for r in rows if r["signal"] == "REVERSAL WATCH"]
if signals:
    top = signals[0]
    signal_key = f"{top['symbol']}|{top['signal']}|{int(top['score'])}"
    st.success(f"🚨 SIGNAL: {top['symbol']} — score {top['score']:.0f}/100 — {', '.join(top['reasons'])}")
    if st.session_state.get("last_signal_key") != signal_key:
        notify_local("BSM Reversal Watch", f"{top['symbol']} reversal watch, score {top['score']:.0f}/100")
        st.session_state["last_signal_key"] = signal_key
else:
    st.session_state["last_signal_key"] = None

st.divider()
st.subheader("Candle chart")
names = [r["symbol"] for r in rows]
selected = st.selectbox("Coin", names, index=0)
r = next(x for x in rows if x["symbol"] == selected)
df = r["df"].tail(100).copy()
df["ema7"] = df.close.ewm(span=7, adjust=False).mean()
df["ema25"] = df.close.ewm(span=25, adjust=False).mean()
df["ema99"] = df.close.ewm(span=99, adjust=False).mean()

fig = go.Figure()
fig.add_trace(go.Candlestick(
    x=df.open_time, open=df.open, high=df.high, low=df.low, close=df.close, name=selected
))
fig.add_trace(go.Scatter(x=df.open_time, y=df.ema7, name="EMA7", mode="lines"))
fig.add_trace(go.Scatter(x=df.open_time, y=df.ema25, name="EMA25", mode="lines"))
fig.add_trace(go.Scatter(x=df.open_time, y=df.ema99, name="EMA99", mode="lines"))
fig.update_layout(height=600, xaxis_rangeslider_visible=False, margin=dict(l=10,r=10,t=30,b=10))
st.plotly_chart(fig, use_container_width=True)

a,b,c,d = st.columns(4)
a.metric("Signal", r["signal"])
b.metric("Score", f"{r['score']:.0f}/100")
c.metric("Funding", f"{r['funding']:.4f}%" if pd.notna(r["funding"]) else "—")
d.metric("Volume", f"{r['vol_ratio']:.2f}×")

st.caption("BSM is an experimental market-observation engine, not financial advice. Its scoring model is deliberately adjustable and must be validated with historical data and paper trading before real-money use.")

if errors:
    with st.expander(f"{len(errors)} data errors"):
        st.write("\n".join(errors))

time.sleep(max(5, int(refresh)))
st.rerun()
