/**
 * Deterministic Italian date/time parsing — the piece Qwen2.5-3B turned out
 * not to be reliable for. Even handed a precomputed day-name table, it
 * produced the SAME wrong date for two different requests ("lunedì" and
 * "venerdì" both became "venerdì 2 ottobre") — arithmetic on a lookup table
 * is still arithmetic for a 3B model. So the model's job is now just
 * extraction (copy the temporal phrase out of the sentence, e.g. "venerdì
 * alle 18", "domani", "lunedì prossimo") — a task small models are actually
 * good at — and this module turns that phrase into an exact ISO datetime.
 *
 * Deliberately narrow: covers the phrasings this app's system prompt asks
 * the model to extract, not general-purpose NLP date parsing. Returns null
 * on anything it doesn't recognize, which the caller turns into a
 * clarifying question rather than a guess.
 */

const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato']
// Accept the accent-free spellings too — model output isn't always careful with them.
const WEEKDAY_ALIASES = {
  domenica: 0, lunedi: 1, lunedì: 1, martedi: 2, martedì: 2, mercoledi: 3, mercoledì: 3,
  giovedi: 4, giovedì: 4, venerdi: 5, venerdì: 5, sabato: 6,
}

const MONTH_NAMES = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
]

/**
 * An explicit calendar date, e.g. "25/09", "25/09/2026" or "25 settembre" —
 * distinct from the relative phrases below ("domani", "venerdì"). Without
 * this, an event booked by exact date ("il 25/09 alle 18") had no date
 * phrase this function recognised, and a bare time did: it silently fell
 * through to the "today" default further down, landing the event on
 * whatever day it happened to be asked rather than the date actually named.
 * Returns a Date at local midnight, or null if nothing matched.
 */
function explicitDate(s, now) {
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s)
  if (slash) {
    const day = Number(slash[1])
    const month = Number(slash[2]) - 1
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const year = slash[3] ? (slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])) : null
      return resolveYear(day, month, year, now)
    }
  }
  const named = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_NAMES.join('|')})(?:\\s+(\\d{4}))?\\b`).exec(s)
  if (named) {
    const day = Number(named[1])
    const month = MONTH_NAMES.indexOf(named[2])
    const year = named[3] ? Number(named[3]) : null
    return resolveYear(day, month, year, now)
  }
  return null
}

/** No year given: this year, unless that already passed more than a month ago — then next year. */
function resolveYear(day, month, year, now) {
  if (year != null) return new Date(year, month, day)
  const thisYear = new Date(now.getFullYear(), month, day)
  const oneMonthAgo = new Date(now)
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)
  return thisYear < oneMonthAgo ? new Date(now.getFullYear() + 1, month, day) : thisYear
}

function atTime(date, hour, minute) {
  const d = new Date(date)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Next date (today included) whose weekday matches `targetDow` (0=Sun..6=Sat). */
function nextWeekday(from, targetDow, { allowToday = true } = {}) {
  const d = new Date(from)
  const diff = (targetDow - d.getDay() + 7) % 7
  d.setDate(d.getDate() + (diff === 0 && !allowToday ? 7 : diff))
  return d
}

/**
 * Parses a short Italian temporal phrase into an ISO datetime string.
 * `now` is injectable for testing; defaults to the real current time.
 */
export function parseItalianWhen(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null
  const s = text.trim().toLowerCase()

  // Time of day: "alle 18", "alle 18:30", "alle 18 e mezza", "alle 9 di sera"
  let hour = null
  let minute = 0
  const timeMatch = /alle\s+(\d{1,2})(?:[:.](\d{2})|\s+e\s+mezza|\s+e\s+un\s+quarto)?/.exec(s)
  // Model-extracted phrases don't always keep the word "alle" — it copies
  // just the end-half of "fino alle 2" and drops the connector, leaving a
  // bare "02:00 del 26/09". A colon/dot HH:MM has no other meaning here
  // (dates in this function always use "/"), so it's an unambiguous fallback.
  const bareTimeMatch = !timeMatch && /\b(\d{1,2})[:.](\d{2})\b/.exec(s)
  if (timeMatch) {
    hour = Number(timeMatch[1])
    if (timeMatch[2]) minute = Number(timeMatch[2])
    else if (/e\s+mezza/.test(timeMatch[0])) minute = 30
    else if (/e\s+un\s+quarto/.test(timeMatch[0])) minute = 15
    if (/di sera|stasera|pomeriggio/.test(s) && hour < 12) hour += 12
  } else if (bareTimeMatch) {
    hour = Number(bareTimeMatch[1])
    minute = Number(bareTimeMatch[2])
    if (/di sera|stasera|pomeriggio/.test(s) && hour < 12) hour += 12
  } else if (/stasera/.test(s)) {
    hour = 20
  } else if (/mattina/.test(s)) {
    hour = 9
  }

  let base = explicitDate(s, now)
  if (base) {
    return atTime(base, hour ?? 9, minute).toISOString()
  }
  if (/\boggi\b/.test(s)) {
    base = new Date(now)
  } else if (/\bdopodomani\b/.test(s)) {
    base = new Date(now)
    base.setDate(base.getDate() + 2)
  } else if (/\bdomani\b/.test(s)) {
    base = new Date(now)
    base.setDate(base.getDate() + 1)
  } else {
    for (const [name, dow] of Object.entries(WEEKDAY_ALIASES)) {
      if (s.includes(name)) {
        // "prossimo lunedì" explicitly means next week even if today is Monday.
        const forceNextWeek = /prossim[oa]/.test(s)
        base = nextWeekday(now, dow, { allowToday: !forceNextWeek })
        if (forceNextWeek && base.toDateString() === new Date(now).toDateString()) {
          base.setDate(base.getDate() + 7)
        }
        break
      }
    }
  }

  if (!base) {
    // No recognizable date phrase — maybe it's just a bare time ("alle 18").
    if (hour != null) base = new Date(now)
    else return null
  }
  return atTime(base, hour ?? 9, minute).toISOString()
}
