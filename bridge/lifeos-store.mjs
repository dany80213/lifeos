/**
 * The LifeOS action data that has nowhere else to live — transactions and
 * meals — as a single JSON file. One user, low write volume, so a plain
 * read-modify-write behind a promise queue (serializing writes so two
 * concurrent actions can't clobber each other) is simpler and just as
 * correct as a real database here.
 *
 * Events live on Apple's own iCloud CalDAV (see lifeos-caldav.mjs) — that's
 * the real calendar Daniele already uses, so writing a second, disconnected
 * copy would just be something else to keep in sync. Health likewise lives
 * in its own daily-snapshot shape, written by the iOS Shortcut webhook.
 *
 * Reminders used to go the same route, through iCloud CalDAV — until it
 * turned out this account's reminders had been silently upgraded to Apple's
 * newer on-device format at some point, which orphaned the CalDAV-visible
 * list: writes succeeded, JARVIS confirmed them, and none of it ever showed
 * up in the actual Reminders app. Fixing that needs either an always-on Mac
 * to write through EventKit, or a phone-side automation — both more than
 * this warrants, so reminders are kept here instead: written for real,
 * visible in LifeOS itself, and whatever notifies about them reads from
 * this same store.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STORE_PATH = fileURLToPath(new URL('../data/lifeos-store.json', import.meta.url))

const EMPTY_STORE = {
  transactions: [], meals: [], reminders: [], health: {},
  // Finanze's accounts/liabilities/assets — previously hardcoded demo data
  // in Finanze.dc.html itself (fictional banks, a fake mortgage, invented
  // crypto holdings). Real, empty by default, edited from the page.
  accounts: [], liabilities: [], assets: [],
  // The user's own movement categories, on top of the built-in ones in
  // lifeos-finance-catalog.mjs: { id, name, kind: 'spesa'|'entrata', emoji }.
  categories: [],
  // Home page's habit checklist — previously 5 hardcoded demo rows in
  // LifeOS.dc.html, always at a fixed "done" state. Real and empty by
  // default; the list itself is edited from Profilo, "done" is per-day
  // (lastDoneDate) so the checklist actually resets every morning.
  habits: [],
  // Scheduled PAC plans — see bridge/recurring-buys.mjs, which runs these on
  // their own, no user action needed once set up.
  recurringBuys: [],
  // Salute e Nutrizione's workout calendar — previously illustrative mock
  // data (fake HR charts/zones that had no real source — the daily Health
  // Shortcut gives one aggregate avgHr/kcal for the whole day, not
  // per-workout). Real now: the user writes these in directly, exercises
  // included, rather than LifeOS pretending to read them from Apple Health.
  workouts: [],
  // TREND IA's last Gemini-generated summary, plus when it was generated —
  // so a page load can decide "still today's, show it" vs "stale, ask
  // Gemini again" without re-calling it on every single fetch. See
  // getFitnessTrend/setFitnessTrend and the /api/lifeos-fitness-trend route.
  fitnessTrend: null,
  // User-supplied API keys for the "ASSISTENTE PER SEZIONE" models Profilo
  // lets you assign per section (see web/lifeos/Profilo.dc.html) — kept here
  // rather than in an env var so they're editable from the page itself.
  // nutritionTargets are Salute e Nutrizione's daily goals — defaults match
  // what used to be hardcoded directly in the page.
  settings: { geminiApiKey: '', nutritionTargets: { kcal: 2400, protein: 160, carbs: 280, fat: 80 } },
  // The signed-in FatSecret user's own diary — separate from `settings`
  // (which Profilo's generic editor reads/writes wholesale) so the OAuth1
  // access token secret is never exposed through that endpoint. null means
  // not connected; see lifeos-fatsecret-diary.mjs for what reads/writes it.
  fatsecretAuth: null,
}

/** Aggregate qty/avg recomputed from an asset's own lots — the lots are the source of truth. */
function recomputeAggregate(asset) {
  const totalQty = asset.lots.reduce((sum, l) => sum + l.qty, 0)
  asset.qty = totalQty
  asset.avg = totalQty ? asset.lots.reduce((sum, l) => sum + l.qty * l.price, 0) / totalQty : 0
}

/**
 * One-time, automatic, and idempotent: folds any pre-existing asset rows
 * that share a symbol into one row with a `lots` array (each old row
 * becomes one lot), instead of the several separate rows the old
 * one-row-per-purchase shape produced. Every original id, quantity and
 * price is kept — nothing is dropped, only regrouped — and load() persists
 * the result once so this never has to run twice on the same data.
 */
function migrateAssetsToLots(store) {
  if (store.assets.every((a) => a.lots)) return false
  const bySymbol = new Map()
  for (const a of store.assets) {
    const key = a.symbol.toLowerCase()
    const lots = a.lots ?? [{ id: a.id, qty: a.qty, price: a.avg, date: a.date ?? null }]
    const existing = bySymbol.get(key)
    if (existing) {
      existing.lots.push(...lots)
      existing.price = Math.max(existing.price, a.price)
    } else {
      bySymbol.set(key, { id: a.id, name: a.name, symbol: a.symbol, assetClass: a.assetClass, price: a.price, qty: 0, avg: 0, lots })
    }
  }
  store.assets = [...bySymbol.values()]
  for (const asset of store.assets) recomputeAggregate(asset)
  return true
}

async function load() {
  try {
    const store = { ...EMPTY_STORE, ...JSON.parse(await readFile(STORE_PATH, 'utf8')) }
    // `settings` is itself an object — the shallow spread above replaces it
    // wholesale rather than merging keys, so a store saved before
    // nutritionTargets existed would otherwise lose the default forever.
    store.settings = { ...EMPTY_STORE.settings, ...store.settings }
    if (migrateAssetsToLots(store)) await save(store)
    return store
  } catch {
    return structuredClone(EMPTY_STORE)
  }
}

async function save(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true })
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2))
}

/** Serializes read-modify-write cycles so concurrent actions don't race. */
let queue = Promise.resolve()
function withStore(mutate) {
  const result = queue.then(async () => {
    const store = await load()
    const out = await mutate(store)
    await save(store)
    return out
  })
  queue = result.then(() => {}, () => {})
  return result
}

export const getStore = () => load()

import { findBank, findCategory } from './lifeos-finance-catalog.mjs'

/**
 * `date` may be 'YYYY-MM-DD' (the day the movement happened — stored at local
 * noon so no timezone shifts it onto another day), a full ISO string, or
 * missing (now). A future or unreadable date falls back to now.
 */
function movementDate(date) {
  if (typeof date === 'string' && date.trim()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : new Date(date)
    if (!Number.isNaN(d.getTime()) && d.getTime() <= Date.now() + 86_400_000) return d.toISOString()
  }
  return new Date().toISOString()
}

export const addTransaction = ({ tx_type, amount, category, account, description, date }) =>
  withStore((store) => {
    const type = tx_type === 'entrata' ? 'entrata' : 'spesa'
    // A name that matches a known category is stored with its canonical spelling;
    // anything else is kept exactly as typed (the chat sometimes invents one).
    const known = findCategory(category, store.categories)
    const record = {
      id: Date.now(),
      type,
      amount: Number(amount) || 0,
      category: known?.name || String(category || '').trim() || (type === 'entrata' ? 'Altre entrate' : 'Altro'),
      // The manual Finanze form and the chat can both name an account now;
      // empty means "none" (older records, or a movement with no account).
      account: String(account || '').trim(),
      description: String(description || '').trim().slice(0, 200),
      date: movementDate(date),
    }
    store.transactions.push(record)
    return record
  })

export const removeTransaction = (id) =>
  withStore((store) => {
    const before = store.transactions.length
    store.transactions = store.transactions.filter((r) => r.id !== id)
    return { removed: store.transactions.length < before }
  })

// protein/carbs/fat default to 0 for the chat and manual-kcal paths, which
// never had macros to give — only a FatSecret-backed add (see
// lifeos-fatsecret.mjs and the /api/lifeos-meal-add route in server.mjs)
// supplies real ones. foodId/servingId are kept only so a search-based add
// CAN be pushed to the user's real FatSecret diary (see pushMealToDiary in
// server.mjs) — a manual entry has neither, and that's exactly why it can
// never be pushed: FatSecret's diary is built from catalog references, not
// free-text calories. fatsecretEntryId is set after a successful push, or
// immediately for a meal imported the other way (see importFatsecretEntries
// below) — either way it's what stops the same meal being synced twice.
export const addMeal = ({ meal_name, kcal, protein, carbs, fat, servingDescription, source, foodId, servingId, fatsecretEntryId, time }) =>
  withStore((store) => {
    const record = {
      id: Date.now(),
      name: meal_name || 'Pasto',
      kcal: Number(kcal) || 0,
      protein: Number(protein) || 0,
      carbs: Number(carbs) || 0,
      fat: Number(fat) || 0,
      servingDescription: servingDescription || '',
      source: source || 'manuale',
      foodId: foodId || null,
      servingId: servingId || null,
      fatsecretEntryId: fatsecretEntryId || null,
      time: time || new Date().toISOString(),
    }
    store.meals.push(record)
    return record
  })

/** Records that a meal was successfully pushed to the user's real FatSecret diary — see pushMealToDiary in server.mjs. */
export const markMealSynced = (id, fatsecretEntryId) =>
  withStore((store) => {
    const meal = store.meals.find((m) => m.id === id)
    if (meal) meal.fatsecretEntryId = fatsecretEntryId
    return meal ?? null
  })

/**
 * Adds any of the day's real FatSecret diary entries LifeOS doesn't already
 * have — matched by fatsecretEntryId, so a meal LifeOS itself just pushed
 * TO FatSecret (see pushMealToDiary) doesn't bounce back as a second,
 * duplicate import on the next sync. FatSecret buckets entries by meal
 * (breakfast/lunch/dinner/other) with no time of day, so `time` here is a
 * synthetic display time per bucket — good enough for sorting the timeline,
 * not a claim about when the food was actually eaten.
 */
export const importFatsecretEntries = (entries) =>
  withStore((store) => {
    const known = new Set(store.meals.map((m) => m.fatsecretEntryId).filter(Boolean))
    const bucketHour = { breakfast: 8, lunch: 13, other: 16, dinner: 20 }
    const added = []
    for (const e of entries) {
      const id = String(e.food_entry_id)
      if (known.has(id)) continue
      // FatSecret returns "meal" capitalized ("Breakfast"), unlike the
      // lowercase values its own food_entry.create expects on the way in.
      const hour = bucketHour[String(e.meal || '').toLowerCase()] ?? 12
      const time = new Date()
      time.setHours(hour, 0, 0, 0)
      const record = {
        id: Date.now() + added.length, // Date.now() alone could collide within one batch
        name: e.food_entry_name || e.food_entry_description || 'Pasto',
        kcal: Math.round(Number(e.calories) || 0),
        protein: Math.round(Number(e.protein) || 0),
        carbs: Math.round(Number(e.carbohydrate) || 0),
        fat: Math.round(Number(e.fat) || 0),
        servingDescription: e.food_entry_description || '',
        source: 'fatsecret-import',
        foodId: e.food_id || null,
        servingId: e.serving_id || null,
        fatsecretEntryId: id,
        time: time.toISOString(),
      }
      store.meals.push(record)
      added.push(record)
    }
    return added
  })

/**
 * Today's kcal/macro totals from the real meal log — what the ring and macro
 * bars on "Salute e Nutrizione" show instead of a fixed mock number. Local
 * calendar day, not UTC, since a meal logged at 23:50 shouldn't count toward
 * tomorrow just because UTC has already rolled over.
 */
export function summarizeMealsForToday(meals) {
  const todayKey = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
  const todays = meals.filter((m) => new Date(m.time).toLocaleDateString('en-CA') === todayKey)
  const totals = todays.reduce(
    (acc, m) => ({
      kcal: acc.kcal + (Number(m.kcal) || 0),
      protein: acc.protein + (Number(m.protein) || 0),
      carbs: acc.carbs + (Number(m.carbs) || 0),
      fat: acc.fat + (Number(m.fat) || 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  )
  return { ...totals, mealCount: todays.length }
}

export const addReminder = ({ text, due_iso }) =>
  withStore((store) => {
    const record = {
      id: Date.now(),
      text: text || 'Promemoria',
      when: due_iso || null,
      done: false,
    }
    store.reminders.push(record)
    return record
  })

/** Removes a completed reminder outright rather than flagging it done — nothing else ever reads a done:true record. */
export const completeReminder = (id) =>
  withStore((store) => {
    const before = store.reminders.length
    store.reminders = store.reminders.filter((r) => r.id !== id)
    return { removed: store.reminders.length < before }
  })

/**
 * Generic add/update/remove for a plain array-of-records collection —
 * accounts, liabilities, assets all share the same shape of operation
 * (add one, edit one field set by id, drop one by id), so one factory
 * beats writing the same three functions three times over.
 */
function collectionOps(key, makeRecord) {
  const add = (fields) =>
    withStore((store) => {
      const record = makeRecord(fields)
      store[key].push(record)
      return record
    })
  const update = (id, fields) =>
    withStore((store) => {
      const idx = store[key].findIndex((r) => r.id === id)
      if (idx === -1) return null
      store[key][idx] = { ...store[key][idx], ...fields }
      return store[key][idx]
    })
  const remove = (id) =>
    withStore((store) => {
      const before = store[key].length
      store[key] = store[key].filter((r) => r.id !== id)
      return { removed: store[key].length < before }
    })
  return { add, update, remove }
}

const accountOps = collectionOps('accounts', ({ name, inst, type, balance, bank }) => {
  // `bank` is a catalogue id (intesa, revolut…); the readable name goes in
  // `inst` as before, so older clients keep showing something sensible.
  const b = findBank(bank)
  return {
  id: Date.now(),
  bank: b?.id || '',
  name: name || b?.name || 'Conto',
  inst: inst || b?.name || '',
  type: ['banche', 'broker', 'crypto'].includes(type) ? type : 'banche',
  balance: Number(balance) || 0,
  }
})
export const addAccount = accountOps.add
export const updateAccount = accountOps.update
export const removeAccount = accountOps.remove

/** A new custom category; refuses duplicates of built-in or existing names. */
export const addCategory = ({ name, kind, emoji }) =>
  withStore((store) => {
    const clean = String(name ?? '').trim().slice(0, 40)
    if (!clean) return { error: 'Serve un nome.' }
    if (findCategory(clean, store.categories)) return { error: 'Esiste già una categoria con questo nome.' }
    const record = { id: Date.now(), name: clean, kind: kind === 'entrata' ? 'entrata' : 'spesa', emoji: String(emoji ?? '').trim().slice(0, 4) }
    store.categories.push(record)
    return record
  })
export const removeCategory = (id) =>
  withStore((store) => {
    const before = store.categories.length
    store.categories = store.categories.filter((c) => c.id !== id)
    return { removed: store.categories.length < before }
  })

const habitOps = collectionOps('habits', ({ name, days }) => ({
  id: Date.now(),
  name: name || 'Abitudine',
  // Weekday indices, JS Date#getDay() convention (0 = domenica … 6 = sabato).
  // Empty = every day — the original, unscoped behaviour.
  days: Array.isArray(days) ? days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
  lastDoneDate: null, // 'YYYY-MM-DD' local date of the last day it was checked, or null
  doneCount: 0, // total times checked done, ever — see updateHabit
  doneDates: [], // every 'YYYY-MM-DD' it was ever checked done — the actual history STREAK ABITUDINI walks
}))
export const addHabit = habitOps.add
export const removeHabit = habitOps.remove

/**
 * Habits get their own update instead of the generic collectionOps one:
 * lastDoneDate flipping null -> a date (or back) is "checked done" /
 * "unchecked" from the page's toggle, and doneCount/doneDates need to move
 * with it. Keeping that here, rather than trusting the caller to compute
 * and send a new count or history, means the Home page's toggle (which only
 * ever sends lastDoneDate) doesn't need to know either one exists.
 */
export const updateHabit = (id, fields) =>
  withStore((store) => {
    const idx = store.habits.findIndex((h) => h.id === id)
    if (idx === -1) return null
    const current = store.habits[idx]
    const next = { ...current, ...fields }
    if ('lastDoneDate' in fields && fields.lastDoneDate !== current.lastDoneDate) {
      const wasDone = !!current.lastDoneDate
      const isDone = !!fields.lastDoneDate
      const doneDates = new Set(current.doneDates || [])
      if (isDone) doneDates.add(fields.lastDoneDate)
      else if (current.lastDoneDate) doneDates.delete(current.lastDoneDate)
      next.doneDates = [...doneDates].sort()
      if (!wasDone && isDone) next.doneCount = (current.doneCount || 0) + 1
      else if (wasDone && !isDone) next.doneCount = Math.max(0, (current.doneCount || 0) - 1)
    }
    store.habits[idx] = next
    return next
  })

const liabilityOps = collectionOps('liabilities', ({ name, original, resid, nextDate }) => ({
  id: Date.now(),
  name: name || 'Passività',
  original: Number(original) || 0,
  resid: Number(resid) || 0,
  nextDate: nextDate || '',
}))
export const addLiability = liabilityOps.add
export const updateLiability = liabilityOps.update
export const removeLiability = liabilityOps.remove

/**
 * One symbol, one row — buying more of something already held adds a lot
 * to that row (and recomputes the real weighted-average cost) instead of
 * creating a second, disconnected row for the same asset. Shared by the
 * manual "add asset" form and by a PAC execution (see
 * applyRecurringBuyExecution below); `date` is when this specific lot was
 * bought, `price` on the asset itself is always just the latest known
 * market price, refreshed on every /api/lifeos-data read.
 */
function mergeAssetLot(store, { name, symbol, assetClass, price, lot }) {
  const key = String(symbol).toLowerCase()
  const asset = store.assets.find((a) => a.symbol.toLowerCase() === key)
  if (asset) {
    asset.lots.push(lot)
    recomputeAggregate(asset)
    asset.price = price
    return asset
  }
  const created = {
    id: Date.now(),
    name: name || 'Asset',
    symbol: symbol || '',
    assetClass: assetClass === 'crypto' ? 'crypto' : 'stock',
    price: Number(price) || 0,
    qty: lot.qty,
    avg: lot.price,
    lots: [lot],
  }
  store.assets.push(created)
  return created
}

export const addAsset = ({ name, symbol, assetClass, qty, avg, price, purchaseDateIso }) =>
  withStore((store) => {
    // The date on the lot is when it was actually BOUGHT, not when this
    // record was typed in — purchaseDateIso is what the form's date/time
    // field resolved to (already used above to look up the historical
    // "avg" price); falling back to now only when the field was left blank.
    const lot = { id: Date.now(), qty: Number(qty) || 0, price: Number(avg) || 0, date: purchaseDateIso || new Date().toISOString() }
    return mergeAssetLot(store, { name, symbol, assetClass, price, lot })
  })

/** Removes the whole position (every lot) — the delete button on the main Asset row. */
export const removeAsset = (id) =>
  withStore((store) => {
    const before = store.assets.length
    store.assets = store.assets.filter((a) => a.id !== id)
    return { removed: store.assets.length < before }
  })

/** Removes one purchase from an asset's detail view — the last lot going also removes the row. */
export const removeAssetLot = (assetId, lotId) =>
  withStore((store) => {
    const asset = store.assets.find((a) => a.id === assetId)
    if (!asset) return { removed: false }
    const before = asset.lots.length
    asset.lots = asset.lots.filter((l) => l.id !== lotId)
    if (!asset.lots.length) {
      store.assets = store.assets.filter((a) => a.id !== assetId)
      return { removed: before > 0, assetRemoved: true }
    }
    recomputeAggregate(asset)
    return { removed: asset.lots.length < before, assetRemoved: false }
  })

const recurringBuyOps = collectionOps('recurringBuys', ({ name, symbol, assetClass, amountEur, frequency, nextRunIso }) => ({
  id: Date.now(),
  name: name || 'Acquisto ricorrente',
  symbol: symbol || '',
  assetClass: assetClass === 'crypto' ? 'crypto' : 'stock',
  amountEur: Number(amountEur) || 0,
  frequency: frequency === 'weekly' ? 'weekly' : 'monthly',
  nextRunIso: nextRunIso || new Date().toISOString(),
  lastRunIso: null,
  active: true,
}))
export const addRecurringBuy = recurringBuyOps.add
export const updateRecurringBuy = recurringBuyOps.update
export const removeRecurringBuy = recurringBuyOps.remove

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const WORKOUT_TYPES = ['Forza', 'Cardio', 'Mobilità']
const workoutOps = collectionOps('workouts', ({ date, type, title, time, durationMinutes, exercises, notes }) => ({
  id: Date.now(),
  date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDateStr(new Date()),
  type: WORKOUT_TYPES.includes(type) ? type : 'Forza',
  title: title || 'Allenamento',
  time: /^\d{1,2}:\d{2}$/.test(time) ? time : '18:00',
  durationMinutes: Number(durationMinutes) || 60,
  // Free-text sets/load ("4x8", "60 kg", "corpo libero"...) rather than
  // separate numeric fields — real gym notation doesn't fit cleanly into
  // numbers (supersets, drop sets, "al cedimento"), so this stays exactly
  // what the user types.
  exercises: Array.isArray(exercises)
    ? exercises
        .map((e) => ({ name: String(e?.name ?? '').trim(), sets: String(e?.sets ?? '').trim(), load: String(e?.load ?? '').trim() }))
        .filter((e) => e.name)
    : [],
  notes: notes || '',
}))
export const addWorkout = workoutOps.add
export const updateWorkout = workoutOps.update
export const removeWorkout = workoutOps.remove

function advanceRunDate(iso, frequency) {
  const d = new Date(iso)
  if (frequency === 'weekly') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1)
  return d.toISOString()
}

/**
 * What actually happens when a PAC plan fires — see recurring-buys.mjs,
 * which resolves the price and calls this. Same symbol already held?
 * Folded into that one row with a real weighted-average cost, matching
 * what buying more of something you already own actually does to your
 * average price; otherwise a new asset row is created.
 */
export const applyRecurringBuyExecution = (buyId, { price, qty }) =>
  withStore((store) => {
    const buy = store.recurringBuys.find((b) => b.id === buyId)
    if (!buy) return null
    const lot = { id: Date.now(), qty, price, date: new Date().toISOString() }
    mergeAssetLot(store, { name: buy.name, symbol: buy.symbol, assetClass: buy.assetClass, price, lot })
    buy.nextRunIso = advanceRunDate(buy.nextRunIso, buy.frequency)
    buy.lastRunIso = new Date().toISOString()
    return { executedQty: qty, executedPrice: price, nextRunIso: buy.nextRunIso }
  })

/** Upserts one day's Health snapshot — a Shortcut may run more than once a day. */
export const setHealthSnapshot = (date, fields) =>
  withStore((store) => {
    store.health[date] = { ...store.health[date], ...fields, date }
    return store.health[date]
  })

/** Whether a FatSecret diary is connected — never the token/secret itself, see fatsecretAuth's own note above. */
export const getFatsecretAuth = async () => (await load()).fatsecretAuth

export const setFatsecretAuth = ({ accessToken, accessTokenSecret }) =>
  withStore((store) => {
    store.fatsecretAuth = { accessToken, accessTokenSecret, connectedAt: new Date().toISOString() }
    return { connected: true }
  })

export const clearFatsecretAuth = () =>
  withStore((store) => {
    store.fatsecretAuth = null
    return { connected: false }
  })

/** TREND IA's cached Gemini summary — see /api/lifeos-fitness-trend in server.mjs for the once-a-day refresh logic. */
export const getFitnessTrend = async () => (await load()).fitnessTrend

export const setFitnessTrend = (lines) =>
  withStore((store) => {
    store.fitnessTrend = { lines, generatedAtIso: new Date().toISOString() }
    return store.fitnessTrend
  })

export const getSettings = async () => (await load()).settings

export const updateSettings = (fields) =>
  withStore((store) => {
    store.settings = { ...store.settings, ...fields }
    return store.settings
  })
