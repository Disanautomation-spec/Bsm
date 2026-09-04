# BSM — Bull/Bear Synchronization Monitor

BSM is a **read-only crypto market intelligence and alert system**. Its central idea is simple: when many contracts become strongly bearish or bullish at nearly the same time, treat that synchronized movement as a market event, then rank individual coins for possible exhaustion/reversal conditions.

The idea is **not final**. BSM is designed as a research framework so the scoring logic can be tested, rejected, refined, or replaced as evidence accumulates.

## Security model

BSM deliberately uses **public Binance market-data endpoints only**. It does not ask for, store, or use:
- Binance API keys
- Binance API secrets
- account permissions
- order permissions
- withdrawal permissions

It cannot place, cancel, or manage Binance orders. The human trader remains the execution layer.

## What BSM is trying to detect

Instead of asking only, “Is this coin going down?”, BSM asks:

1. **Is the market moving together?**
2. **How violent is the move?**
3. **Is volume abnormal?**
4. **Is open interest/funding supporting or contradicting the move?**
5. **Is the individual coin unusually extended?**
6. **Is there evidence of rejection/exhaustion?**
7. **Which coins deserve attention first?**

The first version focuses on synchronized bearish events and reversal-watch candidates. A future engine can score both bullish and bearish events independently.

## Current version

Every refresh BSM:
- checks which configured USDT perpetual contracts are tradable;
- downloads recent candles;
- calculates EMA 7 / 25 / 99;
- measures candle body and range;
- compares volume with its recent average;
- reads public funding and open interest;
- measures synchronized bearishness across the monitored universe;
- combines these observations into a transparent 0–100 reversal-watch score;
- ranks the monitored contracts;
- shows an interactive candlestick chart; and
- can raise a local desktop notification for a new top reversal-watch event.

## Important design principle

BSM does **not** assume that a 2% bearish candle automatically means “buy the dip.” A sharp move can continue much farther. The signal is therefore a **watchlist trigger**, not an automatic trade instruction.

The next major development should be validation: record every BSM event, measure what happened after 1m/5m/15m/30m/1h, and calculate the actual probability, average move, maximum adverse excursion, and false-signal rate.

## Install

### Windows
Install Python 3.11+. Double-click `run_windows.bat`.

### Linux/macOS
```bash
chmod +x run_linux_mac.sh
./run_linux_mac.sh
```

Then open the local Streamlit address shown in the terminal.

## Configure

Edit `config.json` to change the monitored symbols and thresholds.

Example:
```json
{
  "symbols": ["PTBUSDT", "STXUSDT", "COREUSDT"],
  "interval": "15m",
  "lookback": 120,
  "refresh_seconds": 30,
  "signal_threshold": 70,
  "hot_candle_pct": 2.0,
  "reversal_target_pct": 2.0
}
```

## Planned BSM evolution

### BSM 1 — Observation
Current ranking + charts + alerts.

### BSM 2 — Market Pulse
Monitor a much wider USDT-perpetual universe and calculate market breadth, synchronized movement, volatility shock, volume shock, and BTC regime.

### BSM 3 — Flow
Add changes in open interest, funding changes, taker buy/sell imbalance, liquidation information where publicly available, and multi-timeframe confirmation.

### BSM 4 — Reversal Research
Store every event and backtest what happens after each alert. The system should learn which combinations actually have an edge instead of assuming the original idea is correct.

### BSM 5 — Delivery
Add Telegram/push notifications, a mobile-friendly/PWA interface, signal history, event replay, and configurable risk/reward research. Still no exchange execution.

## Philosophy

**Observe → detect synchronization → measure pressure → rank → alert → human verifies → human executes.**

BSM is a research instrument, not a promise of profit.
