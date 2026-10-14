/**
 * FatSecret's OAuth 1.0a three-legged flow and signed food-diary calls — the
 * only way to reach a specific FatSecret user's OWN diary (the one their
 * phone app writes to), unlike the public food database in
 * lifeos-fatsecret.mjs (OAuth2 client-credentials, no user involved).
 *
 * The Consumer Key equals FATSECRET_CLIENT_ID (same value, confirmed against
 * the dashboard), but the Consumer Secret is NOT FATSECRET_CLIENT_SECRET —
 * FatSecret's account page has a second, separate "REST API OAuth 1.0
 * Credentials" section with its own Consumer Secret
 * (FATSECRET_CONSUMER_SECRET). Signing with the OAuth2 Client Secret here
 * fails as "Invalid signature" with no hint that the secret itself is the
 * wrong one — found only by comparing both sections side by side. Both env
 * vars are read lazily inside functions, not at module top level — see the
 * APPLE_ID note in lifeos-caldav.mjs for why a top-level read here would
 * permanently cache `undefined`.
 */

import { createHmac, randomBytes } from 'node:crypto'

const REQUEST_TOKEN_URL = 'https://authentication.fatsecret.com/oauth/request_token'
const AUTHORIZE_URL = 'https://authentication.fatsecret.com/oauth/authorize'
const ACCESS_TOKEN_URL = 'https://authentication.fatsecret.com/oauth/access_token'
const API_URL = 'https://platform.fatsecret.com/rest/server.api'

export class FatSecretDiaryError extends Error {}

function consumerKey() {
  const key = process.env.FATSECRET_CLIENT_ID || null
  if (!key) throw new FatSecretDiaryError('FatSecret non configurato: manca FATSECRET_CLIENT_ID')
  return key
}

function consumerSecret() {
  const secret = process.env.FATSECRET_CONSUMER_SECRET || null
  if (!secret) throw new FatSecretDiaryError('FatSecret non configurato: manca FATSECRET_CONSUMER_SECRET')
  return secret
}

// OAuth1's own flavor of percent-encoding (RFC 3986) — stricter than
// encodeURIComponent, which leaves !*'() unescaped.
function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function signatureBaseString(method, url, params) {
  const encoded = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(String(v))])
    .sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(encoded)}`
}

function sign(method, url, params, tokenSecret) {
  const base = signatureBaseString(method, url, params)
  const key = `${percentEncode(consumerSecret())}&${percentEncode(tokenSecret || '')}`
  return createHmac('sha1', key).update(base).digest('base64')
}

/**
 * One signed round-trip. `token`/`tokenSecret` are the request token (steps
 * 1→3 of the dance) or the final access token (every diary call after that);
 * omit both for step 1, which has no token yet.
 */
/**
 * FatSecret's OAuth1 endpoints read oauth_* straight from the query string
 * (GET) or form body (POST) — sending them via an Authorization: OAuth
 * header instead (the more common approach for other providers) got a
 * "Missing required parameter" back, so this deliberately does it the plain
 * way. The signature is still computed over every param — oauth_* and any
 * genuine API params (method=, date=, …) together — per spec; only the
 * transport is the simple one.
 */
async function signedRequest(method, url, extraParams, token, tokenSecret) {
  const oauthParams = {
    oauth_consumer_key: consumerKey(),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(token ? { oauth_token: token } : {}),
  }
  const params = { ...oauthParams, ...extraParams }
  params.oauth_signature = sign(method, url, params, tokenSecret)

  const qs = new URLSearchParams(params).toString()
  const res = await fetch(method === 'GET' ? `${url}?${qs}` : url, {
    method,
    ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs }),
  })
  const text = await res.text()
  if (!res.ok) throw new FatSecretDiaryError(`richiesta FatSecret fallita (${res.status}): ${text.slice(0, 200)}`)
  return text
}

/** Step 1 — a short-lived request token tied to the callback the user's browser lands back on after approving. */
export async function getRequestToken(callbackUrl) {
  const text = await signedRequest('POST', REQUEST_TOKEN_URL, { oauth_callback: callbackUrl })
  const params = new URLSearchParams(text)
  if (params.get('oauth_callback_confirmed') !== 'true') {
    throw new FatSecretDiaryError('FatSecret non ha confermato il callback')
  }
  return { token: params.get('oauth_token'), tokenSecret: params.get('oauth_token_secret') }
}

/** Step 2 — where to send the user's browser to log into THEIR FatSecret account and approve access. */
export function authorizeUrl(requestToken) {
  return `${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(requestToken)}`
}

/** Step 3 — the approved request token + verifier (from the callback query string) become a long-lived access token. */
export async function getAccessToken(requestToken, requestTokenSecret, verifier) {
  const text = await signedRequest('GET', ACCESS_TOKEN_URL, { oauth_verifier: verifier }, requestToken, requestTokenSecret)
  const params = new URLSearchParams(text)
  const accessToken = params.get('oauth_token')
  const accessTokenSecret = params.get('oauth_token_secret')
  if (!accessToken || !accessTokenSecret) throw new FatSecretDiaryError('scambio access token fallito')
  return { accessToken, accessTokenSecret }
}

/** Days-since-epoch in the LOCAL calendar day — what FatSecret's `date`/`date_int` params expect, matching how its own app buckets a day regardless of UTC. */
export function localDateInt(date = new Date()) {
  // Date.UTC (not `new Date(y,m,d).getTime()`) — the latter builds a LOCAL
  // midnight and converts it to a UTC instant, which in a positive-UTC-offset
  // zone (e.g. CEST, UTC+2) lands on the PREVIOUS UTC calendar day (22:00
  // UTC the day before), giving yesterday's day count. Date.UTC treats the
  // y/m/d as already being the date we want, no timezone shift applied.
  const utcMidnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.floor(utcMidnight / 86_400_000)
}

/** Every diary entry FatSecret has for that local day — calories/macros already resolved per entry, no extra food.get needed. */
export async function getFoodEntries(accessToken, accessTokenSecret, dateInt) {
  const text = await signedRequest(
    'GET', API_URL, { method: 'food_entries.get.v2', date: String(dateInt), format: 'json' },
    accessToken, accessTokenSecret,
  )
  const data = JSON.parse(text)
  if (data.error) throw new FatSecretDiaryError(data.error.message || 'errore FatSecret')
  const raw = data.food_entries?.food_entry
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

/**
 * Writes one entry into the user's real diary — only possible for a food
 * that came from FatSecret's own database (needs its food_id + serving_id),
 * never for a plain manual kcal entry: FatSecret's diary is built from
 * catalog references, not free-text calories.
 */
export async function createFoodEntry(accessToken, accessTokenSecret, { foodId, servingId, name, meal, dateInt }) {
  const text = await signedRequest(
    'POST', API_URL,
    {
      method: 'food_entry.create', format: 'json',
      food_id: String(foodId), serving_id: String(servingId), number_of_units: '1',
      food_entry_name: name, meal, date: String(dateInt),
    },
    accessToken, accessTokenSecret,
  )
  const data = JSON.parse(text)
  if (data.error) throw new FatSecretDiaryError(data.error.message || 'errore FatSecret')
  return data.food_entry
}

/** Local-hour heuristic for which of FatSecret's four fixed meal buckets a just-logged meal falls into. */
export function mealBucketFor(date = new Date()) {
  const h = date.getHours()
  if (h < 11) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 18) return 'other'
  return 'dinner'
}
