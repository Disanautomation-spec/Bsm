/* ============================================================
   BSM V5
   Binance Signal Machine
   ============================================================

   PURPOSE
   -------
   Public-market-data intelligence and alerting engine.

   NO:
   - Binance account access
   - API keys
   - order execution
   - trade automation

   YES:
   - public Binance Futures market data
   - dynamic USDT perpetual universe
   - 1m / 3m / 5m analysis
   - price acceleration
   - relative volume
   - volatility abnormality
   - open interest
   - funding
   - liquidations
   - market breadth
   - synchronization detection
   - trap / exhaustion analysis
   - empirical signal logging

   ============================================================ */


/* ============================================================
   DOM
   ============================================================ */

const rowsEl =
  document.getElementById("rows");

const radarListEl =
  document.getElementById("radarList");

const pairCountEl =
  document.getElementById("pairCount");

const pulseUp =
  document.getElementById("pulseUp");

const pulseDown =
  document.getElementById("pulseDown");

const pulseFlat =
  document.getElementById("pulseFlat");

const pulseRegime =
  document.getElementById("pulseRegime");

const regimeBar =
  document.getElementById("regimeBar");

const eventBanner =
  document.getElementById("eventBanner");

const eventBody =
  document.getElementById("eventBody");

const eventSub =
  document.getElementById("eventSub");

const toastContainer =
  document.getElementById("toastContainer");

const liveClock =
  document.getElementById("liveClock");

const bellBtn =
  document.getElementById("bellBtn");

const connectionLabel =
  document.getElementById("connectionLabel");

const dotKline =
  document.getElementById("dotKline");

const dotMark =
  document.getElementById("dotMark");

const dotLiq =
  document.getElementById("dotLiq");

const dotSystem =
  document.getElementById("dotSystem");


/* ============================================================
   CONFIGURATION
   ============================================================ */

const CONFIG = {

  /*
   * Keep this reasonably broad.
   *
   * This is NOT intended to mean "top 240 coins".
   * It is simply a browser resource limit.
   *
   * Later the backend can remove this limitation.
   */
  MAX_SYMBOLS: 240,

  /*
   * Binance combined stream connection size.
   */
  CHUNK_SIZE: 70,

  /*
   * Closed 1m candles kept per coin.
   */
  CANDLE_CAP: 90,

  /*
   * Historical baseline.
   */
  BASELINE_N: 30,

  /*
   * Minimum candles before scoring.
   */
  MIN_CANDLES: 12,

  /*
   * Candidate event threshold.
   */
  EVENT_THRESHOLD: 48,

  /*
   * Strong event threshold.
   */
  HOT_THRESHOLD: 68,

  /*
   * Extreme event threshold.
   */
  EXTREME_THRESHOLD: 84,

  /*
   * Minimum setup quality for directional signal.
   */
  SETUP_THRESHOLD: 55,

  /*
   * Alert cooldown per coin.
   */
  ALERT_COOLDOWN_MS:
    3 * 60 * 1000,

  /*
   * Signal logging cooldown.
   */
  LOG_COOLDOWN_MS:
    5 * 60 * 1000,

  /*
   * Liquidation history.
   */
  LIQ_WINDOW_MS:
    5 * 60 * 1000,

  /*
   * OI history.
   */
  OI_WINDOW_MS:
    15 * 60 * 1000,

  /*
   * Market breadth window.
   */
  MARKET_WINDOW_MS:
    2 * 60 * 1000,

  /*
   * WebSocket reconnect.
   */
  WS_RECONNECT_MS:
    2500

};


/* ============================================================
   OPTIONAL BSM BACKEND
   ============================================================

   When the Render/backend gateway exists, this can become:

   const DATA_GATEWAY = "https://YOUR-BSM-BACKEND.onrender.com";

   For now leave empty to use direct public Binance streams.

   IMPORTANT:
   If Binance blocks the browser/network with HTTP 451,
   the frontend cannot solve that by changing JavaScript.
   The correct production solution is the BSM backend/gateway.
   ============================================================ */

const DATA_GATEWAY = "";


/* ============================================================
   STATE
   ============================================================ */

const coins =
  new Map();

let universe =
  [];

let websocketConnections =
  [];

let alertsEnabled =
  false;

let audioCtx =
  null;

let selectedSym =
  null;

let lastMarketSnapshot =
  null;

let lastRender =
  0;

let renderScheduled =
  false;


/* ============================================================
   COIN STATE
   ============================================================ */

function getCoin(sym){

  let c =
    coins.get(sym);

  if(!c){

    c = {

      symbol:sym,

      candles:[],

      live:null,

      funding:null,

      fundingHist:[],

      oi:null,

      oiHist:[],

      longLiqs:[],

      shortLiqs:[],

      stage:"QUIET",

      lifecycle:[],

      episodeDir:0,

      episodePeak:null,

      episodeTrough:null,

      lastLog:0,

      lastAlert:0,

      lastSignalKey:null,

      lastPriceUpdate:0

    };

    coins.set(sym,c);

  }

  return c;

}


/* ============================================================
   TIME PRUNING
   ============================================================ */

function pruneT(arr,ms){

  const now =
    Date.now();

  while(
    arr.length &&
    now-arr[0].t > ms
  ){
    arr.shift();
  }

}


/* ============================================================
   SAFE NUMBER
   ============================================================ */

function num(v, fallback=0){

  const n =
    Number(v);

  return Number.isFinite(n)
    ? n
    : fallback;

}


/* ============================================================
   BINANCE EXCHANGE INFO
   ============================================================ */

async function fetchUniverse(){

  setDiagnostic(
    "Loading Binance USDⓈ-M Futures universe…"
  );

  try{

    const url =
      DATA_GATEWAY
        ? DATA_GATEWAY + "/api/exchangeInfo"
        : "https://fapi.binance.com/fapi/v1/exchangeInfo";

    const response =
      await fetch(
        url,
        {
          cache:"no-store"
        }
      );

    if(!response.ok){

      throw new Error(
        `exchangeInfo HTTP ${response.status}`
      );

    }

    const data =
      await response.json();

    const symbols =
      (data.symbols || [])

      .filter(s =>
        s.status === "TRADING" &&
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT"
      )

      .map(s => s.symbol)

      .filter(Boolean);


    /*
     * We don't simply take the first N symbols.
     *
     * Binance exchangeInfo order is not an intelligence ranking.
     *
     * For browser V5 we use a deterministic universe.
     * Production backend V6 will rank the full universe dynamically.
     */

    universe =
      symbols
        .slice()
        .sort()
        .slice(
          0,
          CONFIG.MAX_SYMBOLS
        );


    universe.forEach(
      getCoin
    );

    pairCountEl.textContent =
      `${universe.length} pairs`;

    setStream(
      dotSystem,
      true
    );

    setDiagnostic(
      `Tracking ${universe.length} Binance USDT perpetuals.`
    );

    return universe;

  }catch(error){

    console.error(
      "Universe error:",
      error
    );

    setStream(
      dotSystem,
      false
    );

    setDiagnostic(
      `Universe error: ${error.message}. ` +
      `If Binance returns 451, use the BSM backend gateway.`
    );

    return [];

  }

}


/* ============================================================
   WEBSOCKET URL
   ============================================================ */

function streamBase(){

  /*
   * A future backend can expose:
   *
   * wss://backend/ws
   *
   * but for the direct public-data prototype:
   */

  return "wss://fstream.binance.com/stream?streams=";

}


/* ============================================================
   BUILD STREAM LIST
   ============================================================ */

function buildStreams(symbols){

  const streams = [];

  for(const sym of symbols){

    const s =
      sym.toLowerCase();

    /*
     * Real 1m kline.
     */
    streams.push(
      `${s}@kline_1m`
    );

    /*
     * Mark price includes funding.
     */
    streams.push(
      `${s}@markPrice@1s`
    );

  }

  return streams;

}


/* ============================================================
   CHUNK
   ============================================================ */

function chunk(arr,size){

  const out = [];

  for(
    let i=0;
    i<arr.length;
    i+=size
  ){

    out.push(
      arr.slice(
        i,
        i+size
      )
    );

  }

  return out;

}


/* ============================================================
   START MARKET STREAMS
   ============================================================ */

function startStreams(){

  stopStreams();

  if(!universe.length)
    return;


  const symbolChunks =
    chunk(
      universe,
      CONFIG.CHUNK_SIZE
    );


  /*
   * Separate market streams from liquidation stream.
   */

  for(
    const symbolChunk
    of symbolChunks
  ){

    const streams =
      buildStreams(
        symbolChunk
      );

    connectCombined(
      streams
    );

  }


  /*
   * Global liquidation stream.
   *
   * One stream for all symbols.
   */

  connectLiquidations();

}


/* ============================================================
   COMBINED WEBSOCKET
   ============================================================ */

function connectCombined(streams){

  if(!streams.length)
    return;

  const url =
    streamBase() +
    streams.join("/");

  let ws;

  try{

    ws =
      new WebSocket(url);

  }catch(error){

    console.error(error);

    setStream(
      dotKline,
      false
    );

    return;

  }

  websocketConnections.push(ws);

  let alive =
    false;


  ws.onopen = () => {

    alive = true;

    setStream(
      dotKline,
      true
    );

    setStream(
      dotMark,
      true
    );

    updateConnectionLabel();

  };


  ws.onmessage =
    event => {

      try{

        const message =
          JSON.parse(
            event.data
          );

        const payload =
          message.data ||
          message;

        handleBinanceMessage(
          payload
        );

      }catch(error){

        console.warn(
          "WS parse error",
          error
        );

      }

    };


  ws.onerror =
    error => {

      console.warn(
        "WebSocket error",
        error
      );

      setStream(
        dotKline,
        false
      );

      setStream(
        dotMark,
        false
      );

    };


  ws.onclose =
    () => {

      alive = false;

      setStream(
        dotKline,
        false
      );

      setStream(
        dotMark,
        false
      );

      updateConnectionLabel();


      /*
       * Reconnect this stream.
       */

      setTimeout(
        () => {

          if(
            websocketConnections.includes(ws)
          ){

            connectCombined(
              streams
            );

          }

        },
        CONFIG.WS_RECONNECT_MS
      );

    };

}


/* ============================================================
   LIQUIDATION STREAM
   ============================================================ */

function connectLiquidations(){

  const url =
    "wss://fstream.binance.com/ws/!forceOrder@arr";

  let ws;

  try{

    ws =
      new WebSocket(url);

  }catch(error){

    console.error(error);

    return;

  }

  websocketConnections.push(ws);


  ws.onopen =
    () => {

      setStream(
        dotLiq,
        true
      );

    };


  ws.onmessage =
    event => {

      try{

        const data =
          JSON.parse(
            event.data
          );

        const order =
          data.o;

        if(!order)
          return;

        const sym =
          order.s;

        const side =
          order.S;

        const qty =
          num(order.q);

        const price =
          num(order.ap || order.p);

        if(
          sym &&
          qty > 0 &&
          price > 0
        ){

          onLiquidation(
            sym,
            side,
            qty,
            price
          );

        }

      }catch(error){

        console.warn(
          "Liquidation parse error",
          error
        );

      }

    };


  ws.onerror =
    () => {

      setStream(
        dotLiq,
        false
      );

    };


  ws.onclose =
    () => {

      setStream(
        dotLiq,
        false
      );

      setTimeout(
        connectLiquidations,
        CONFIG.WS_RECONNECT_MS
      );

    };

}


/* ============================================================
   STOP STREAMS
   ============================================================ */

function stopStreams(){

  for(
    const ws
    of websocketConnections
  ){

    try{
      ws.close();
    }catch(e){}

  }

  websocketConnections =
    [];

}


/* ============================================================
   BINANCE MESSAGE ROUTER
   ============================================================ */

function handleBinanceMessage(data){

  if(!data)
    return;


  /*
   * Kline
   */

  if(data.e === "kline"){

    const k =
      data.k;

    if(k){

      onKline(
        data.s,
        k
      );

    }

    return;

  }


  /*
   * Mark price.
   */

  if(
    data.e === "markPriceUpdate"
  ){

    onFunding(
      data.s,
      num(data.r)
    );

    return;

  }

}


/* ============================================================
   KLINE
   ============================================================ */

function onKline(sym,k){

  if(!sym || !k)
    return;

  const c =
    getCoin(sym);

  const close =
    num(k.c);

  const qVol =
    num(k.q);

  const t =
    num(k.t);

  if(
    close <= 0 ||
    t <= 0
  )
    return;


  c.live = {

    t,
    close,
    qVol

  };

  c.lastPriceUpdate =
    Date.now();


  /*
   * Only closed candles become historical baseline.
   */

  if(k.x){

    const last =
      c.candles[
        c.candles.length-1
      ];

    /*
     * Avoid duplicate closed candle.
     */

    if(
      !last ||
      last.t !== t
    ){

      c.candles.push({

        t,
        close,
        qVol

      });

    }

    while(
      c.candles.length >
      CONFIG.CANDLE_CAP
    ){

      c.candles.shift();

    }

  }


  scheduleRender();

}


/* ============================================================
   FUNDING
   ============================================================ */

function onFunding(sym,rate){

  const c =
    getCoin(sym);

  c.funding =
    rate;

  c.fundingHist.push({

    t:Date.now(),
    rate

  });

  pruneT(
    c.fundingHist,
    15*60*1000
  );

}


/* ============================================================
   LIQUIDATION
   ============================================================ */

function onLiquidation(
  sym,
  side,
  qty,
  price
){

  const c =
    getCoin(sym);

  const notional =
    qty * price;

  if(
    !Number.isFinite(notional) ||
    notional <= 0
  )
    return;


  /*
   * Binance:
   *
   * SELL forced order =
   * long position was liquidated.
   *
   * BUY forced order =
   * short position was liquidated.
   */

  if(side === "SELL"){

    c.longLiqs.push({

      t:Date.now(),
      notional

    });

  }else if(side === "BUY"){

    c.shortLiqs.push({

      t:Date.now(),
      notional

    });

  }


  pruneT(
    c.longLiqs,
    CONFIG.LIQ_WINDOW_MS
  );

  pruneT(
    c.shortLiqs,
    CONFIG.LIQ_WINDOW_MS
  );

}


/* ============================================================
   OI
   ============================================================

   Browser V5 uses periodic REST OI polling.

   This is deliberately kept separate from the WebSocket
   candle stream.

   ============================================================ */

async function pollOpenInterest(){

  /*
   * Poll only tracked symbols.
   *
   * Production BSM backend should do this centrally and
   * cache results.
   */

  const sample =
    universe.slice(
      0,
      CONFIG.MAX_SYMBOLS
    );


  /*
   * Keep request concurrency low.
   */

  const concurrency =
    8;

  let index =
    0;


  async function worker(){

    while(
      index < sample.length
    ){

      const sym =
        sample[index++];

      try{

        const url =
          DATA_GATEWAY
            ? DATA_GATEWAY +
              `/api/openInterest?symbol=${encodeURIComponent(sym)}`
            : `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(sym)}`;

        const response =
          await fetch(
            url,
            {
              cache:"no-store"
            }
          );

        if(!response.ok)
          continue;

        const data =
          await response.json();

        const oi =
          num(data.openInterest);

        if(oi > 0){

          onOI(
            sym,
            oi
          );

        }

      }catch(error){

        /*
         * Individual OI failures should never kill
         * the whole scanner.
         */

      }

    }

  }


  const workers =
    Array.from(
      {
        length:
          Math.min(
            concurrency,
            sample.length
          )
      },
      worker
    );

  await Promise.all(
    workers
  );

  scheduleRender();

}


/* ============================================================
   OI
   ============================================================ */

function onOI(sym,oi){

  const c =
    getCoin(sym);

  c.oi =
    oi;

  c.oiHist.push({

    t:Date.now(),
    oi

  });

  pruneT(
    c.oiHist,
    CONFIG.OI_WINDOW_MS
  );

}


/* ============================================================
   SERIES
   ============================================================ */

function closeSeries(c){

  const arr =
    c.candles.map(
      x => x.close
    );

  if(c.live)
    arr.push(
      c.live.close
    );

  return arr;

}


/* ============================================================
   PERCENTAGE BACK
   ============================================================ */

function pctBack(
  series,
  n
){

  if(
    series.length <= n
  )
    return null;

  const now =
    series[
      series.length-1
    ];

  const ref =
    series[
      series.length-1-n
    ];

  if(
    !Number.isFinite(now) ||
    !Number.isFinite(ref) ||
    ref <= 0
  )
    return null;

  return (
    (now-ref)/ref
  )*100;

}


/* ============================================================
   RETURNS
   ============================================================ */

function candleReturns(c){

  const closes =
    c.candles.map(
      x => x.close
    );

  const out = [];

  for(
    let i=1;
    i<closes.length;
    i++
  ){

    if(
      closes[i-1] > 0
    ){

      out.push(
        (
          closes[i] -
          closes[i-1]
        ) /
        closes[i-1]
      );

    }

  }

  return out;

}


/* ============================================================
   STANDARD DEVIATION
   ============================================================ */

function stdev(arr){

  if(
    arr.length < 2
  )
    return null;

  const mean =
    arr.reduce(
      (a,b)=>a+b,
      0
    ) /
    arr.length;

  const variance =
    arr.reduce(
      (a,b)=>
        a +
        Math.pow(
          b-mean,
          2
        ),
      0
    ) /
    arr.length;

  return Math.sqrt(
    variance
  );

}


/* ============================================================
   MEAN
   ============================================================ */

function mean(arr){

  if(!arr.length)
    return 0;

  return (
    arr.reduce(
      (a,b)=>a+b,
      0
    ) /
    arr.length
  );

}


/* ============================================================
   WINDOW SUM
   ============================================================ */

function sumWindow(
  arr,
  ms
){

  const no
