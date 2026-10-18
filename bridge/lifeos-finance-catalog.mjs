/**
 * Fixed catalogue for Finanze: the banks an account can belong to and the
 * categories a movement can have. Clients (iPhone/Mac app, web, the Groq tool)
 * all read it from /api/lifeos-data → financeCatalog, so there is one list.
 *
 * Banks carry a `domain`: clients show the site's own icon (fetched from it at
 * runtime, nothing is redistributed here) and fall back to a coloured
 * monogram when it cannot be loaded. `color` is the brand colour for that fallback.
 *
 * Custom categories live in the store (`categories`) and are merged in by
 * `buildCatalog`; the built-in ones can't be edited or removed.
 */

export const BANKS = [
  { id: 'intesa', name: 'Intesa Sanpaolo', domain: 'intesasanpaolo.com', color: '#00794C', initials: 'IS' },
  { id: 'unicredit', name: 'UniCredit', domain: 'unicredit.it', color: '#E2001A', initials: 'UC' },
  { id: 'bnl', name: 'BNL', domain: 'bnl.it', color: '#00A651', initials: 'BNL' },
  { id: 'bancobpm', name: 'Banco BPM', domain: 'bancobpm.it', color: '#C8102E', initials: 'BPM' },
  { id: 'mps', name: 'Monte dei Paschi', domain: 'mps.it', color: '#003D7C', initials: 'MPS' },
  { id: 'bper', name: 'BPER Banca', domain: 'bper.it', color: '#00529B', initials: 'BP' },
  { id: 'fineco', name: 'Fineco', domain: 'finecobank.com', color: '#00539F', initials: 'FB' },
  { id: 'mediolanum', name: 'Banca Mediolanum', domain: 'bancamediolanum.it', color: '#009FE3', initials: 'BM' },
  { id: 'ing', name: 'ING', domain: 'ing.it', color: '#FF6200', initials: 'ING' },
  { id: 'webank', name: 'Webank', domain: 'webank.it', color: '#E30613', initials: 'WB' },
  { id: 'widiba', name: 'Widiba', domain: 'widiba.it', color: '#FF5A00', initials: 'WD' },
  { id: 'poste', name: 'Poste Italiane', domain: 'poste.it', color: '#FFD500', initials: 'PI', darkText: true },
  { id: 'revolut', name: 'Revolut', domain: 'revolut.com', color: '#0666EB', initials: 'R' },
  { id: 'n26', name: 'N26', domain: 'n26.com', color: '#36A18B', initials: 'N26' },
  { id: 'hype', name: 'Hype', domain: 'hype.it', color: '#00B0F0', initials: 'H' },
  { id: 'satispay', name: 'Satispay', domain: 'satispay.com', color: '#E8352B', initials: 'S' },
  { id: 'paypal', name: 'PayPal', domain: 'paypal.com', color: '#003087', initials: 'PP' },
  { id: 'wise', name: 'Wise', domain: 'wise.com', color: '#9FE870', initials: 'W', darkText: true },
  { id: 'bbva', name: 'BBVA', domain: 'bbva.it', color: '#004481', initials: 'BB' },
  { id: 'trade-republic', name: 'Trade Republic', domain: 'traderepublic.com', color: '#1A1A1A', initials: 'TR' },
  { id: 'directa', name: 'Directa', domain: 'directa.it', color: '#00A0DC', initials: 'D' },
  { id: 'scalable', name: 'Scalable Capital', domain: 'scalable.capital', color: '#00D6B0', initials: 'SC', darkText: true },
  { id: 'degiro', name: 'DEGIRO', domain: 'degiro.it', color: '#1D8AEE', initials: 'DG' },
  { id: 'binance', name: 'Binance', domain: 'binance.com', color: '#F3BA2F', initials: 'BN', darkText: true },
  { id: 'coinbase', name: 'Coinbase', domain: 'coinbase.com', color: '#0052FF', initials: 'CB' },
  { id: 'altro', name: 'Altro / contanti', domain: '', color: '#6B7280', initials: '€' },
]

const sp = (name, emoji, symbol) => ({ name, kind: 'spesa', emoji, symbol, custom: false })
const en = (name, emoji, symbol) => ({ name, kind: 'entrata', emoji, symbol, custom: false })

export const DEFAULT_CATEGORIES = [
  sp('Alimentari', '🛒', 'cart.fill'),
  sp('Ristoranti e bar', '🍽️', 'fork.knife'),
  sp('Casa', '🏠', 'house.fill'),
  sp('Bollette e utenze', '💡', 'bolt.fill'),
  sp('Trasporti', '🚌', 'bus.fill'),
  sp('Carburante', '⛽', 'fuelpump.fill'),
  sp('Salute', '💊', 'cross.case.fill'),
  sp('Svago e tempo libero', '🎬', 'film.fill'),
  sp('Shopping', '🛍️', 'bag.fill'),
  sp('Viaggi', '✈️', 'airplane'),
  sp('Abbonamenti', '🔁', 'repeat'),
  sp('Istruzione', '🎓', 'graduationcap.fill'),
  sp('Regali', '🎁', 'gift.fill'),
  sp('Assicurazioni', '🛡️', 'shield.fill'),
  sp('Tasse e commissioni', '🏛️', 'building.columns.fill'),
  sp('Cura della persona', '💈', 'scissors'),
  sp('Animali', '🐾', 'pawprint.fill'),
  sp('Altro', '📦', 'square.grid.2x2.fill'),
  en('Stipendio', '💼', 'briefcase.fill'),
  en('Extra e bonus', '🎉', 'party.popper.fill'),
  en('Rimborsi', '↩️', 'arrow.uturn.backward.circle.fill'),
  en('Regali ricevuti', '🎁', 'gift.fill'),
  en('Vendite', '🏷️', 'tag.fill'),
  en('Interessi e dividendi', '📈', 'chart.line.uptrend.xyaxis'),
  en('Affitti', '🔑', 'key.fill'),
  en('Altre entrate', '💰', 'banknote.fill'),
]

export const CUSTOM_EMOJI = '🏷️'
export const CUSTOM_SYMBOL = 'tag.fill'

/** Built-in categories + the user's own (store.categories), ready for the clients. */
export function buildCatalog(customCategories = []) {
  const custom = (customCategories ?? []).map((c) => ({
    id: c.id, name: c.name, kind: c.kind === 'entrata' ? 'entrata' : 'spesa',
    emoji: c.emoji || CUSTOM_EMOJI, symbol: CUSTOM_SYMBOL, custom: true,
  }))
  return { banks: BANKS, categories: [...DEFAULT_CATEGORIES, ...custom] }
}

const norm = (s) => String(s ?? '').trim().toLowerCase()

/** Exact (case-insensitive) match against built-in + custom names; null if unknown. */
export function findCategory(name, customCategories = []) {
  const n = norm(name)
  if (!n) return null
  return buildCatalog(customCategories).categories.find((c) => norm(c.name) === n) ?? null
}

export const findBank = (idOrName) => {
  const n = norm(idOrName)
  return BANKS.find((b) => b.id === n || norm(b.name) === n) ?? null
}
