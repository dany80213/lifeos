/**
 * Live and historical prices for crypto (CoinGecko) and stocks/ETFs (Yahoo
 * Finance) — both free, no API key. Backs Finanze's asset form: the user
 * gives a symbol, quantity and purchase date/time, never a price — "prezzo
 * medio" (their real cost basis) comes from the historical price at that
 * moment, "prezzo attuale" from a live lookup. Both in EUR; a non-EUR quote
 * (US stocks trade in USD) is converted with a same-day FX rate.
 *
 * CoinGecko's free tier caps historical lookups at the last 365 days — a
 * purchase older than that falls back to today's price rather than failing
 * the whole thing, so the row still gets created.
 */

const CRYPTO_IDS = {
  btc: 'bitcoin', eth: 'ethereum', sol: 'solana', ada: 'cardano', xrp: 'ripple',
  doge: 'dogecoin', dot: 'polkadot', ltc: 'litecoin', link: 'chainlink',
  matic: 'matic-network', avax: 'avalanche-2', bnb: 'binancecoin',
  usdt: 'tether', usdc: 'usd-coin', shib: 'shiba-inu', trx: 'tron',
}

async function resolveCryptoId(symbol) {
  const key = String(symbol).trim().toLowerCase()
  if (CRYPTO_IDS[key]) return CRYPTO_IDS[key]
  const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`)
  if (!res.ok) return null
  const data = await res.json()
  const match = data.coins?.find((c) => c.symbol?.toLowerCase() === key) ?? data.coins?.[0]
  return match?.id ?? null
}

async function fetchCryptoCurrent(id) {
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=eur`)
  if (!res.ok) throw new Error('Prezzo crypto non disponibile al momento.')
  const data = await res.json()
  const p = data[id]?.eur
  if (p == null) throw new Error('Prezzo crypto non disponibile al momento.')
  return p
}

async function fetchCryptoHistorical(id, dateIso) {
  const d = new Date(dateIso)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 364)
  if (d < cutoff) return fetchCryptoCurrent(id) // outside CoinGecko's free-tier window
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/history?date=${dd}-${mm}-${d.getFullYear()}&localization=false`)
  if (!res.ok) return fetchCryptoCurrent(id)
  const data = await res.json()
  return data.market_data?.current_price?.eur ?? (await fetchCryptoCurrent(id))
}

async function cryptoPrices(symbol, purchaseDateIso) {
  const id = await resolveCryptoId(symbol)
  if (!id) throw new Error(`Simbolo crypto "${symbol}" non riconosciuto.`)
  const price = await fetchCryptoCurrent(id)
  const avg = purchaseDateIso ? await fetchCryptoHistorical(id, purchaseDateIso) : price
  return { price, avg }
}

/** 24h/7d/30d/1y % change — CoinGecko's full coin endpoint already computes all four itself. */
async function cryptoDetails(symbol) {
  const id = await resolveCryptoId(symbol)
  if (!id) throw new Error(`Simbolo crypto "${symbol}" non riconosciuto.`)
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`)
  if (!res.ok) throw new Error('Dati crypto non disponibili al momento.')
  const data = await res.json()
  const md = data.market_data
  if (md?.current_price?.eur == null) throw new Error('Dati crypto non disponibili al momento.')
  return {
    price: md.current_price.eur,
    d24: md.price_change_percentage_24h ?? 0,
    d7: md.price_change_percentage_7d ?? 0,
    d30: md.price_change_percentage_30d ?? 0,
    d1a: md.price_change_percentage_1y ?? 0,
  }
}

const YAHOO_HEADERS = { 'user-agent': 'Mozilla/5.0' }

let fxCache = null // { rate, fetchedAt } — same-day FX barely moves; one lookup covers a whole add
async function usdToEurRate() {
  const today = new Date().toISOString().slice(0, 10)
  if (fxCache?.date === today) return fxCache.rate
  const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR')
  if (!res.ok) return 1 // better an unconverted number than a hard failure
  const data = await res.json()
  const rate = data.rates?.EUR ?? 1
  fxCache = { date: today, rate }
  return rate
}

async function toEur(amount, currency) {
  if (!currency || currency === 'EUR') return amount
  if (currency === 'USD') return amount * (await usdToEurRate())
  return amount // an FX pair beyond USD/EUR isn't worth the extra API for now
}

async function fetchChart(symbol, extraParams = '') {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d${extraParams}`,
    { headers: YAHOO_HEADERS },
  )
  if (!res.ok) return null
  return res.json()
}

/**
 * A bare ticker only works as-is for symbols with no exchange suffix on
 * Yahoo (most US ones). A European listing needs one — "EUNL" is nothing,
 * "EUNL.DE" is the real Xetra symbol — and guessing at suffixes (.DE, .MI,
 * .L, …) is a losing game, so this asks Yahoo's own search/autocomplete for
 * the best match instead, and resolves through THAT symbol from here on.
 */
async function resolveStock(symbol) {
  const direct = await fetchChart(symbol, '&range=1d')
  const directMeta = direct?.chart?.result?.[0]?.meta
  if (directMeta?.regularMarketPrice != null) return { resolvedSymbol: symbol, meta: directMeta }

  const searchRes = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}`, { headers: YAHOO_HEADERS })
  const searchData = searchRes.ok ? await searchRes.json() : null
  const best = searchData?.quotes?.find((q) => q.isYahooFinance && q.symbol)
  if (!best) throw new Error(`Simbolo "${symbol}" non trovato.`)

  const retry = await fetchChart(best.symbol, '&range=1d')
  const retryMeta = retry?.chart?.result?.[0]?.meta
  if (retryMeta?.regularMarketPrice == null) throw new Error(`Prezzo per "${symbol}" non disponibile.`)
  return { resolvedSymbol: best.symbol, meta: retryMeta }
}

async function fetchStockHistorical(resolvedSymbol, dateIso, currency) {
  const target = new Date(dateIso)
  const period1 = Math.floor(target.getTime() / 1000) - 6 * 86400 // covers a weekend + a holiday
  const period2 = Math.floor(target.getTime() / 1000) + 1 * 86400
  const data = await fetchChart(resolvedSymbol, `&period1=${period1}&period2=${period2}`)
  const result = data?.chart?.result?.[0]
  const closes = result?.indicators?.quote?.[0]?.close
  const timestamps = result?.timestamp
  if (!closes?.length || !timestamps?.length) return null
  // Last trading close at or before the target moment.
  const targetSec = target.getTime() / 1000
  let idx = timestamps.findIndex((ts) => ts > targetSec)
  idx = idx === -1 ? timestamps.length - 1 : Math.max(0, idx - 1)
  const close = closes[idx]
  return close == null ? null : toEur(close, currency)
}

async function stockPrices(symbol, purchaseDateIso) {
  const { resolvedSymbol, meta } = await resolveStock(symbol)
  const price = await toEur(meta.regularMarketPrice, meta.currency)
  const avg = purchaseDateIso ? (await fetchStockHistorical(resolvedSymbol, purchaseDateIso, meta.currency)) ?? price : price
  return { price, avg }
}

/**
 * 24h/7d/30d/1y % change for a stock/ETF. Yahoo's own meta only carries the
 * 24h figure (regularMarketChangePercent) — the rest come from one year of
 * daily closes fetched in a single request, each just "closest close to N
 * days ago vs. today", not a second round trip per period.
 */
async function stockDetails(symbol) {
  const { resolvedSymbol, meta } = await resolveStock(symbol)
  const data = await fetchChart(resolvedSymbol, '&range=1y')
  const result = data?.chart?.result?.[0]
  const closes = result?.indicators?.quote?.[0]?.close
  const timestamps = result?.timestamp
  const price = meta.regularMarketPrice
  if (!closes?.length || !timestamps?.length) {
    return { price: await toEur(price, meta.currency), d24: meta.regularMarketChangePercent ?? 0, d7: 0, d30: 0, d1a: 0 }
  }
  // Anchored to the data's OWN last bar, not Date.now(): every daily bar is
  // stamped at the same time of day (session open), so "1 day ago" measured
  // from wall-clock now drifts past that anchor as the day goes on and
  // lands back on TODAY's own bar instead of yesterday's — measured on
  // EUNL.DE mid-afternoon, where this made d24 compare today's price to
  // itself (~0%) instead of the real ~1.8% move. Anchoring to the last
  // timestamp keeps every offset exactly N bars apart regardless of when
  // in the day this runs.
  const latestTs = timestamps[timestamps.length - 1]
  const closeAt = (daysAgo) => {
    const targetSec = latestTs - daysAgo * 86400
    let idx = timestamps.findIndex((ts) => ts >= targetSec)
    idx = idx === -1 ? timestamps.length - 1 : idx
    // A market holiday's bar carries a null close (seen on EUNL.DE: Xetra
    // was shut 2026-09-21 and that day's close came back null) — walk back
    // to the nearest real one instead of returning null, which pctChange
    // would silently read as "no change" rather than the real recent move.
    while (idx > 0 && closes[idx] == null) idx--
    return closes[idx]
  }
  const pctChange = (past) => (past ? ((price - past) / past) * 100 : 0)
  return {
    price: await toEur(price, meta.currency),
    // Not meta.regularMarketChangePercent: its chartPreviousClose reference
    // has been seen disagreeing with this very closes[] array by over a
    // point (EUNL.DE showed 0.61% there against a verified 1.83% from the
    // actual last close) — deriving d24 from the same series as d7/d30/d1a
    // keeps the whole row internally consistent with one verifiable source.
    d24: pctChange(closeAt(1)),
    d7: pctChange(closeAt(7)),
    d30: pctChange(closeAt(30)),
    d1a: pctChange(closeAt(365)),
  }
}

/** Daily price points since `sinceIso` — capped at CoinGecko's free-tier 365-day history window. */
async function cryptoHistory(symbol, sinceIso) {
  const id = await resolveCryptoId(symbol)
  if (!id) throw new Error(`Simbolo crypto "${symbol}" non riconosciuto.`)
  const daysSince = Math.ceil((Date.now() - new Date(sinceIso).getTime()) / 86400000)
  const days = Math.min(Math.max(daysSince, 1), 365)
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=eur&days=${days}&interval=daily`)
  if (!res.ok) throw new Error('Storico crypto non disponibile al momento.')
  const data = await res.json()
  return (data.prices ?? []).map(([ts, price]) => ({ date: new Date(ts).toISOString(), price }))
}

/** Daily closes since `sinceIso` — Yahoo has no free-tier cap the way CoinGecko does, so this covers however far back the purchase actually was. */
async function stockHistory(symbol, sinceIso) {
  const { resolvedSymbol, meta } = await resolveStock(symbol)
  const period1 = Math.floor(new Date(sinceIso).getTime() / 1000)
  const period2 = Math.floor(Date.now() / 1000)
  const data = await fetchChart(resolvedSymbol, `&period1=${period1}&period2=${period2}`)
  const result = data?.chart?.result?.[0]
  const closes = result?.indicators?.quote?.[0]?.close
  const timestamps = result?.timestamp
  if (!closes?.length || !timestamps?.length) return []
  const rate = meta.currency === 'USD' ? await usdToEurRate() : 1
  const conv = meta.currency && meta.currency !== 'EUR' ? (v) => v * rate : (v) => v
  const out = []
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue
    out.push({ date: new Date(timestamps[i] * 1000).toISOString(), price: conv(closes[i]) })
  }
  return out
}

/**
 * The daily series behind the ANDAMENTI chart — real closes since a given
 * date (normally an asset's earliest lot purchase), not a fabricated line.
 */
export async function lookupHistory({ assetClass, symbol, sinceIso }) {
  if (!symbol || !String(symbol).trim()) throw new Error('Manca il simbolo.')
  const since = sinceIso || new Date(Date.now() - 30 * 86400000).toISOString()
  return assetClass === 'crypto' ? cryptoHistory(symbol, since) : stockHistory(symbol, since)
}

/**
 * The one export the rest of the app calls. `assetClass` is what the add-
 * asset form's type picker sends ('crypto' | 'azione' | 'etf' — the latter
 * two both resolve through Yahoo, which doesn't distinguish them).
 */
export async function lookupPrices({ assetClass, symbol, purchaseDateIso }) {
  if (!symbol || !String(symbol).trim()) throw new Error('Manca il simbolo.')
  return assetClass === 'crypto' ? cryptoPrices(symbol, purchaseDateIso) : stockPrices(symbol, purchaseDateIso)
}

/** Current price plus real 24h/7d/30d/1y % change — used to refresh a held asset row. */
// /api/lifeos-data asks for the same quotes on every load (BTC alone is fetched for the navbar chip AND
// for the BTC holding), and every client refresh repeats that — enough to trip CoinGecko's free-tier
// rate limit, at which point the quote silently vanished. A short cache absorbs the bursts, and if a
// fetch still fails the last good quote is served instead of nothing.
const DETAILS_TTL_MS = 60_000
const detailsCache = new Map() // key -> { at, value, inflight }

export async function lookupDetails({ assetClass, symbol }) {
  if (!symbol || !String(symbol).trim()) throw new Error('Manca il simbolo.')
  const key = `${assetClass}:${String(symbol).trim().toUpperCase()}`
  const hit = detailsCache.get(key)
  if (hit?.value && Date.now() - hit.at < DETAILS_TTL_MS) return hit.value
  if (hit?.inflight) return hit.inflight
  const inflight = (assetClass === 'crypto' ? cryptoDetails(symbol) : stockDetails(symbol))
    .then((value) => {
      detailsCache.set(key, { at: Date.now(), value })
      return value
    })
    .catch((err) => {
      const stale = detailsCache.get(key)?.value
      detailsCache.set(key, { at: stale ? Date.now() - DETAILS_TTL_MS + 10_000 : 0, value: stale })
      if (stale) return stale
      throw err
    })
  detailsCache.set(key, { at: hit?.at ?? 0, value: hit?.value, inflight })
  return inflight
}
