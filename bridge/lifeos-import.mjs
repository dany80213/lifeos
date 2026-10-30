/**
 * Bank-statement import for Finanze. Drop in a statement export and the bank is
 * recognised from the file itself — no choosing, no mapping:
 *
 *   BuddyBank  .xls   "Rapporto: IT… - NAME" header, Causale / Descrizione columns
 *   Revolut    .csv   Type,Product,Started Date,… (the "Current" product only)
 *   Satispay   .xlsx  sheet "Transactions", Date/Name/Type/Status
 *
 * parseStatement() turns any of them into the same shape; planImport() decides what
 * to do with each row (skip own transfers, pick a category) and importStatement()
 * writes it. Every imported movement carries a `ref`, so the same file — or an
 * overlapping export — can be dropped again without duplicating anything.
 *
 * Category choice learns from the store: a merchant already categorised by hand
 * (or by an earlier import you corrected) keeps that category next time.
 */

import { createHash } from 'node:crypto'
import XLSX from 'xlsx'
import { findCategory } from './lifeos-finance-catalog.mjs'

const OWN_NAME = /porcaro\s+daniele|daniele\s+porcaro/i

const pad = (n) => String(n).padStart(2, '0')
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const serialToDay = (n) => isoDay(new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000))
const euro = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'))
const round2 = (n) => Math.round(n * 100) / 100

function csvRows(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

// ---- parsers: each returns { bank, accountName, balance, rows } ----------------------------------
// A row: { date 'YYYY-MM-DD', amount (signed), label, detail, own (money moved between the
//          user's own accounts), id (the bank's own id when it gives one), hint (category hint) }

function parseRevolut(text) {
  const [header, ...lines] = csvRows(text)
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
  const rows = []
  let balance = null
  for (const r of lines) {
    // The savings pocket ("Deposit") only mirrors transfers from the current account.
    if (r[col.Product] !== 'Current' || r[col.State] !== 'COMPLETED') continue
    const type = r[col.Type], desc = r[col.Description].trim()
    // What really left or entered the account: Revolut lists fees apart from the amount.
    const amount = round2(Number(r[col.Amount]) - Number(r[col.Fee]))
    balance = Number(r[col.Balance])
    const own = /^To (Instant Access Savings|investment account|Daniele Porcaro)$|^From Instant Access Savings$/i.test(desc) ||
      (type === 'Deposit' && OWN_NAME.test(desc))
    rows.push({
      date: r[col['Started Date']].slice(0, 10), time: r[col['Started Date']].slice(11),
      amount, label: desc.replace(/^Payment from |^Transfer (to|from) /i, ''), detail: desc, own,
      person: !own && /^(Transfer (to|from)|Payment from) /i.test(desc),
      hint: type === 'Charge' || type === 'Fee' ? 'Tasse e commissioni' : type === 'Reward' ? 'Extra e bonus' : '',
    })
  }
  return { bank: 'revolut', accountName: 'Revolut', balance, rows }
}

function parseSatispay(wb) {
  const data = XLSX.utils.sheet_to_json(wb.Sheets.Transactions, { header: 1, raw: true })
  const rows = []
  let latest = null
  for (const r of data.slice(1)) {
    const [when, name, descr, amount, type, status, , after, id] = r
    if (!when || !/approved/i.test(String(status))) continue
    const at = when instanceof Date ? when : new Date(when)
    // Dates come back as UTC-shifted Date objects; the wall-clock fields are what the sheet shows.
    const date = isoDay(new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())))
    const t = String(type).replace(/^[^\p{L}]+/u, '').trim()
    if (!latest || at > latest.at) latest = { at, after }
    const own = /savings|investment/i.test(t) || /^(to|from) bank$/i.test(t) || /outbound bank/i.test(t) && OWN_NAME.test(name)
    rows.push({
      date, time: at.toTimeString().slice(0, 8), amount: Number(amount), label: String(name).trim(), detail: [name, descr, t].filter(Boolean).join(' · '),
      own, person: !own && /person|gift/i.test(t), id: id ? String(id).split('\n')[0] : '',
      hint: /commissions/i.test(t) ? 'Tasse e commissioni' : /pagopa/i.test(t) ? 'Tasse e commissioni' : /mobile top-up/i.test(t) ? 'Bollette e utenze' : '',
    })
  }
  return { bank: 'satispay', accountName: 'Satispay', balance: latest ? Number(latest.after) : null, rows }
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'’/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())

function parseBuddybank(wb) {
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true })
  const bal = data.map((r) => /^Saldo Contabile:\s*([\d.,]+)/.exec(String(r[0]))).find(Boolean)
  const start = data.findIndex((r) => String(r[0]).startsWith('Data registrazione'))
  const rows = []
  for (const r of data.slice(start + 1)) {
    const [reg, , , desc, amount] = r
    if (!(reg instanceof Date || typeof reg === 'number') || !amount) continue // footer lines and "competenze" of 0,00
    const d = String(desc).replace(/\s+/g, ' ').trim()
    // +12 h so the zone/second quirks of legacy .xls dates can't push it onto another day.
    let person = false
    let date = reg instanceof Date ? isoDay(new Date(reg.getTime() + 12 * 3_600_000)) : serialToDay(reg), label = d, own = false, hint = ''
    let m
    if ((m = /PAGAMENTO .*? DEL (\d{2})\/(\d{2})\/(\d{4}) CARTA \*?\d+ DI EUR [\d.,]+ (.+)$/.exec(d))) {
      date = `${m[3]}-${m[2]}-${m[1]}` // the day of the purchase, not of the booking
      label = titleCase(m[4]).replace(/\b\d{3,}\b/g, '').replace(/\s+/g, ' ').trim()
    } else if ((m = /^(BONIFICO A VOSTRO FAVORE|DISPOSIZIONE DI BONIFICO) .*?(?:DA|A): (.+?)(?: PER: (.*?))?(?: TRN:| COMM| SPESE|$)/.exec(d))) {
      const who = m[2].trim(), why = (m[3] || '').trim()
      label = titleCase(who) + (why && !/^sent from revolut$/i.test(why) ? ` — ${titleCase(why)}` : '')
      own = OWN_NAME.test(who) || /SATISPAY EUROPE/i.test(who)
      if (/regalo/i.test(why)) hint = 'Regali ricevuti'
      person = !own && !hint
    } else if (/SDD .*SATISPAY|SATISPAY APP TOP-UP/i.test(d)) { own = true; label = 'Ricarica Satispay' }
    else if (/COMMISSIONI|SPESE COSTO/i.test(d)) { hint = 'Tasse e commissioni'; label = titleCase(d.replace(/^COMMISSIONI - PROVVIGIONI - SPESE\s*/, '').replace(/\bN\.\*\d+/, '')) }
    else if (/VERSAMENTO SU SPORTELLO/i.test(d)) label = 'Versamento ATM'
    rows.push({ date, time: '', amount: Number(amount), label: label.trim(), detail: d, own, person, hint })
  }
  return { bank: 'buddybank', accountName: 'BuddyBank', balance: bal ? euro(bal[1]) : null, rows }
}

export function parseStatement(buffer) {
  const head = buffer.subarray(0, 200).toString('latin1')
  if (/^Type,Product,Started Date/.test(head)) return parseRevolut(buffer.toString('utf8'))
  let wb
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: true }) } catch { throw new Error('File non leggibile: non è un estratto conto Excel o CSV.') }
  if (wb.Sheets.Transactions) return parseSatispay(wb)
  const first = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true })
  if (first.some((r) => String(r[0]).startsWith('Rapporto:')) && first.some((r) => String(r[2]) === 'Causale')) return parseBuddybank(wb)
  throw new Error('Formato non riconosciuto. Supporto gli estratti BuddyBank (.xls), Revolut (.csv) e Satispay (.xlsx).')
}

const RULES = [
  [/lidl|carrefour|bennet|conad|coop\b|esselunga|eurospin|\bpam\b|despar|iper|penny|aldi|supermerc|ipercoop|dok\b|\bgdc\b/i, 'Alimentari'],
  [/mc ?donald|burger|pizz|ristor|trattor|osteria|\bbar\b|caff[eè]|dist caffo|gelat|sushi|kebab|starbucks|autogrill|paninoteca/i, 'Ristoranti e bar'],
  [/stazione|distributor|\beni\b|q8|tamoil|\bip\b|esso|carburant|benzin/i, 'Carburante'],
  [/norauto|autostrad|telepass|gtt|trenitalia|italo|uber|taxi|parcheggi|atm\b|road tax|bollo/i, 'Trasporti'],
  [/amazon|decathlon|zalando|shein|ikea|h&m|zara|mediaworld|unieuro|ebay|aliexpress/i, 'Shopping'],
  [/anthropic|openai|spotify|netflix|disney|prime video|apple\.com|icloud|google|youtube|dazn|playstation|xbox|steam/i, 'Abbonamenti'],
  [/windtre|wind tre|tim\b|vodafone|iliad|enel|eni plenitude|a2a|iren|bolletta|ricarica telefon|top-up/i, 'Bollette e utenze'],
  [/farmaci|pharma|parafarm|ottica|medic|dentist|ospedal/i, 'Salute'],
  [/cinema|teatro|concert|ticketone|bowling/i, 'Svago e tempo libero'],
  [/commission|card delivery|costo (emissione|spedizione)|pagopa/i, 'Tasse e commissioni'],
  [/barbier|parrucch|estetic/i, 'Cura della persona'],
]

// ---- deciding what each row is --------------------------------------------------------------------
//
// Four outcomes: a movement with a category, a movement between friends (kept apart from
// spese/entrate), an own transfer to leave out, or "ask": the app shows a pop-up and the
// answer is remembered (store.importRules) so the same merchant or person never asks again.

const key = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim()
export const ruleKey = (label, type, kind) => (kind === 'category' ? `${type}|${key(label)}` : `*|${key(label)}`)

function learnedCategories(store) {
  const map = new Map()
  for (const t of store.transactions ?? []) if (t.description && t.category) map.set(`${t.type}|${key(t.description)}`, t.category)
  return map
}

function decide(row, type, ctx) {
  const rules = ctx.store.importRules ?? {}
  const k = key(row.label)
  const rule = rules[`*|${k}`] ?? rules[`${type}|${k}`]
  if (rule?.kind === 'ignore') return { kind: 'ignore' }
  if (rule?.kind === 'amici') return { kind: 'amici' }
  if (rule?.kind === 'category') return { kind: 'category', category: rule.category, how: 'appresa' }
  const learned = ctx.learned.get(`${type}|${k}`)
  if (learned) return { kind: 'category', category: learned, how: 'appresa' }
  const named = (n) => findCategory(n, ctx.store.categories)?.name
  if (row.hint && named(row.hint)) return { kind: 'category', category: named(row.hint), how: 'regola' }
  if (row.person) return { kind: 'ask', suggestion: 'amici' }
  if (type === 'spesa') {
    const hit = RULES.find(([re]) => re.test(row.label))
    return hit ? { kind: 'category', category: hit[1], how: 'regola' } : { kind: 'ask', suggestion: 'Altro' }
  }
  if (/interess/i.test(row.detail)) return { kind: 'category', category: 'Interessi e dividendi', how: 'regola' }
  if (/stipendio|emolument/i.test(row.detail)) return { kind: 'category', category: 'Stipendio', how: 'regola' }
  return { kind: 'ask', suggestion: 'Altre entrate' }
}

/** The category a merchant's expense would get here, or null when we have no idea (used by receipts too). */
export function suggestCategory(label, store) {
  const d = decide({ label, detail: label }, 'spesa', { store, learned: learnedCategories(store) })
  return d.kind === 'category' ? d.category : null
}

// ---- plan + write --------------------------------------------------------------------------------

const refOf = (bank, row, n) =>
  row.id ? `${bank}:${row.id}` : `${bank}:${createHash('sha1').update(`${row.date}|${row.time}|${row.amount}|${row.detail}|${n}`).digest('hex').slice(0, 16)}`

/** Decides, row by row, what an import would do — without touching the store. */
export function planImport(parsed, store) {
  const ctx = { store, learned: learnedCategories(store) }
  const known = new Set([...(store.transactions ?? []), ...(store.friendTx ?? []), ...(store.pendingImports ?? [])].map((t) => t.ref).filter(Boolean))
  const seen = new Map()
  // Number repeats of an otherwise identical row oldest-first, so a later, overlapping export
  // gives the same rows the same ref no matter how many newer rows were added in front.
  const oldestFirst = parsed.rows.length > 1 && parsed.rows[0].date > parsed.rows.at(-1).date ? [...parsed.rows].reverse() : parsed.rows
  const receipts = (store.transactions ?? []).filter((t) => t.source === 'scontrino' && !t.ref)
  const claimed = new Set()
  const out = { add: [], ask: [], receipts: [], duplicates: 0, own: 0, empty: 0 }
  for (const row of oldestFirst) {
    const sig = `${row.date}|${row.time}|${row.amount}|${row.detail}`
    const n = seen.get(sig) ?? 0
    seen.set(sig, n + 1)
    if (!row.amount) { out.empty++; continue }
    const ref = refOf(parsed.bank, row, n)
    if (known.has(ref)) { out.duplicates++; continue }
    if (row.own) { out.own++; continue }
    const type = row.amount < 0 ? 'spesa' : 'entrata'
    // Already entered from a photo of the receipt: same amount within 3 days. The movement stays as
    // the user confirmed it and takes this row's ref, so it counts as "già presente" from now on.
    const receipt = type === 'spesa' && receipts.find((t) => !claimed.has(t.id) && t.amount === Math.abs(row.amount) && Math.abs(new Date(t.date) - new Date(`${row.date}T12:00:00`)) <= 3 * 864e5)
    if (receipt) {
      claimed.add(receipt.id)
      out.receipts.push({ id: receipt.id, ref })
      out.duplicates++
      continue
    }
    const base = { ref, type, amount: Math.abs(row.amount), date: row.date, description: row.label.slice(0, 200), detail: row.detail.slice(0, 300), person: !!row.person }
    const d = decide(row, type, ctx)
    if (d.kind === 'ignore') out.own++
    else if (d.kind === 'ask') out.ask.push({ ...base, suggestion: d.suggestion })
    else out.add.push({ ...base, kind: d.kind, category: d.category, how: d.how })
  }
  return out
}

const noon = (day) => { const d = day.split('-').map(Number); return new Date(d[0], d[1] - 1, d[2], 12).toISOString() }
let seq = 0
const nextId = () => Date.now() * 10 + (seq++ % 10)

/** Files one movement: under spese/entrate, or in the friends ledger. */
function commit(store, accountName, t) {
  if (t.kind === 'amici') {
    store.friendTx.push({ id: nextId(), friend: t.description, amount: t.type === 'spesa' ? -t.amount : t.amount, account: accountName, date: noon(t.date), ref: t.ref })
  } else {
    store.transactions.push({ id: nextId(), type: t.type, amount: t.amount, category: t.category, account: accountName, description: t.description, date: noon(t.date), ref: t.ref })
  }
}

/** Applies an import inside an open store (see withStore in lifeos-store.mjs). */
export function applyImport(store, parsed, plan) {
  store.friendTx ??= []; store.pendingImports ??= []; store.importRules ??= {}
  let account = store.accounts.find((a) => a.bank === parsed.bank)
  const created = !account
  if (!account) {
    account = { id: nextId(), bank: parsed.bank, name: parsed.accountName, inst: parsed.accountName, type: 'banche', balance: 0 }
    store.accounts.push(account)
  }
  for (const t of plan.add) commit(store, account.name, t)
  for (const { id, ref } of plan.receipts) {
    const t = store.transactions.find((x) => x.id === id)
    if (t) { t.ref = ref; t.account ||= account.name }
  }
  for (const q of plan.ask) store.pendingImports.push({ ...q, id: nextId(), account: account.name })
  const latest = parsed.rows.reduce((m, r) => (r.date > m ? r.date : m), '')
  // A balance only moves forward: re-dropping an old export must not roll it back.
  const balanceUpdated = parsed.balance != null && latest >= (account.balanceAsOf || '')
  if (balanceUpdated) { account.balance = parsed.balance; account.balanceAsOf = latest }
  return { account: account.name, accountCreated: created, balanceUpdated, balance: account.balance }
}

/**
 * The user's answer to one pop-up: choice = { kind: 'category', category } | { kind: 'amici' } | { kind: 'ignore' }.
 * It is remembered, and applied to every other waiting movement of the same merchant or person.
 */
export function resolvePending(store, id, choice) {
  store.friendTx ??= []; store.pendingImports ??= []; store.importRules ??= {}
  const item = store.pendingImports.find((q) => q.id === id)
  if (!item) return { error: 'Movimento non trovato.' }
  const kind = ['category', 'amici', 'ignore'].includes(choice?.kind) ? choice.kind : null
  if (!kind) return { error: 'Scelta non valida.' }
  let category = ''
  if (kind === 'category') {
    category = findCategory(choice.category, store.categories)?.name || String(choice.category ?? '').trim()
    if (!category) return { error: 'Scegli una categoria.' }
  }
  store.importRules[ruleKey(item.description, item.type, kind)] = kind === 'category' ? { kind, category } : { kind }
  const same = (q) => key(q.description) === key(item.description) && (kind !== 'category' || q.type === item.type)
  const done = store.pendingImports.filter(same)
  store.pendingImports = store.pendingImports.filter((q) => !same(q))
  for (const q of done) if (kind !== 'ignore') commit(store, q.account, { ...q, kind, category })
  return { resolved: done.length, remaining: store.pendingImports.length }
}

export const summarize = (parsed, plan, applied) => ({
  bank: parsed.bank,
  account: applied?.account ?? parsed.accountName,
  accountCreated: applied?.accountCreated ?? false,
  balance: parsed.balance,
  balanceUpdated: applied?.balanceUpdated ?? false,
  added: plan.add.length,
  toAsk: plan.ask.length,
  duplicates: plan.duplicates,
  ownTransfers: plan.own,
  movements: plan.add.map(({ date, type, amount, category, description, how, kind }) => ({ date, type, amount, category: kind === 'amici' ? 'Tra amici' : category, description, how })),
  questions: plan.ask.map(({ date, type, amount, description }) => ({ date, type, amount, description })),
})
