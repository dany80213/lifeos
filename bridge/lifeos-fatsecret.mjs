/**
 * FatSecret Platform API client — food database search and per-serving
 * nutrition, used by "Salute e Nutrizione" to fill in real calories/macros
 * instead of a hand-typed kcal guess. OAuth2 client-credentials only: this
 * reads FatSecret's public food database, it never touches a user's own
 * FatSecret diary (there isn't one — LifeOS keeps its own meal log, see
 * lifeos-store.mjs).
 *
 * FATSECRET_CLIENT_ID/FATSECRET_CLIENT_SECRET are read lazily, inside
 * getAccessToken(), not at module top level — see the APPLE_ID note in
 * lifeos-caldav.mjs for why a top-level `process.env.FATSECRET_CLIENT_ID`
 * here would permanently cache `undefined`.
 */

const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token'
const API_URL = 'https://platform.fatsecret.com/rest/server.api'

/** Thrown when the two env vars aren't set, or FatSecret itself rejects a call. */
export class FatSecretError extends Error {}

let cachedToken = null // { value, expiresAt }

async function getAccessToken() {
  const clientId = process.env.FATSECRET_CLIENT_ID || null
  const clientSecret = process.env.FATSECRET_CLIENT_SECRET || null
  if (!clientId || !clientSecret) {
    throw new FatSecretError('FatSecret non configurato: mancano FATSECRET_CLIENT_ID/FATSECRET_CLIENT_SECRET')
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
    body: 'grant_type=client_credentials&scope=basic',
  })
  if (!res.ok) throw new FatSecretError(`autenticazione FatSecret fallita (${res.status})`)
  const data = await res.json()
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 }
  return cachedToken.value
}

async function callApi(params) {
  const token = await getAccessToken()
  const url = new URL(API_URL)
  url.search = new URLSearchParams({ format: 'json', ...params }).toString()
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new FatSecretError(`richiesta FatSecret fallita (${res.status})`)
  const data = await res.json()
  if (data.error) throw new FatSecretError(data.error.message || 'errore FatSecret')
  return data
}

/**
 * Up to `maxResults` matches for a free-text query, cheapest fields only —
 * enough to render a picker. Nutrition comes later, from getFoodDetail, only
 * for the one the user actually picks.
 */
export async function searchFoods(query, maxResults = 8) {
  const q = String(query || '').trim()
  if (!q) return []
  const data = await callApi({ method: 'foods.search', search_expression: q, max_results: String(maxResults) })
  const raw = data.foods?.food
  if (!raw) return []
  const items = Array.isArray(raw) ? raw : [raw]
  return items.map((f) => ({
    id: f.food_id,
    name: f.food_name,
    brand: f.brand_name || null,
    // FatSecret's own one-line summary, e.g. "Per 100g - Calories: 165kcal
    // | Fat: 3.60g | Carbs: 0.00g | Protein: 31.00g" — shown in the picker
    // so the user can tell servings apart before committing to one.
    description: f.food_description || '',
  }))
}

/** Prefers a named "1 serving"/"1 porzione" entry over a bare 100g row, else just the first. */
function pickDefaultServing(servings) {
  const list = Array.isArray(servings) ? servings : [servings]
  return list.find((s) => /\bserving\b|porzione/i.test(s.serving_description || '')) || list[0]
}

/** Real calories + macros (grams) for one food, from its default serving. */
export async function getFoodDetail(foodId) {
  const data = await callApi({ method: 'food.get.v2', food_id: String(foodId) })
  const food = data.food
  const servings = food?.servings?.serving
  if (!food || !servings) throw new FatSecretError('alimento non trovato')
  const serving = pickDefaultServing(servings)
  return {
    id: food.food_id,
    name: food.food_name,
    brand: food.brand_name || null,
    servingId: serving.serving_id,
    servingDescription: serving.serving_description || '',
    kcal: Math.round(Number(serving.calories) || 0),
    protein: Math.round(Number(serving.protein) || 0),
    carbs: Math.round(Number(serving.carbohydrate) || 0),
    fat: Math.round(Number(serving.fat) || 0),
  }
}
