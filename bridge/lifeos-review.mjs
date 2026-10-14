/**
 * Weekly habit summaries — what the Review page's "COSA È ANDATO BENE" /
 * "COSA È SLITTATO" cards and week counter are built from, and what gets
 * fed to Gemini as real context when it's asked to summarize or compare
 * weeks (see runGeminiModel in server.mjs).
 *
 * Habits are the only thing in the store with real day-by-day history
 * (doneDates — see lifeos-store.mjs's updateHabit). Reminders aren't:
 * completeReminder deletes a reminder outright rather than flagging it
 * done, so there's no trace of what was completed once it's gone. That's
 * why a weekly review of "what I did" can only honestly be about habits.
 */

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Monday=0 … Sunday=6 — how this module (and the Review page) talks about a week, unlike Date#getDay's Sunday=0. */
function mondayIndex(date) {
  return (date.getDay() + 6) % 7
}

/** Local midnight on the Monday that starts this date's week. */
function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() - mondayIndex(d))
  return d
}

/** ISO-8601 week number/year — decided by the Thursday of the week, per the standard. */
function isoWeek(date) {
  const thursday = startOfWeek(date)
  thursday.setDate(thursday.getDate() + 3)
  const firstThursday = startOfWeek(new Date(thursday.getFullYear(), 0, 4))
  firstThursday.setDate(firstThursday.getDate() + 3)
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400000))
  return { year: thursday.getFullYear(), week }
}

const WEEKDAY_IT = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica']

function habitDoneDatesOf(h) {
  return new Set([...(h.doneDates || []), ...(h.lastDoneDate ? [h.lastDoneDate] : [])])
}

/**
 * Everything about one Monday–Sunday week: per habit, how many of its
 * scheduled days so far were done vs missed (a day later in the week than
 * `now` hasn't happened yet, so it counts as neither), plus the same
 * "successful day" count Home's STREAK ABITUDINI uses — a day with no
 * habits scheduled on it counts as successful, same reasoning as a rest day
 * not breaking a streak.
 */
function summarizeWeek(habits, weekStart, now) {
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return d
  })
  const pastOrToday = days.filter((d) => d <= now)

  const perHabit = habits.map((h) => {
    const doneDates = habitDoneDatesOf(h)
    const scheduled = pastOrToday.filter((d) => !h.days || !h.days.length || h.days.includes(d.getDay()))
    const missed = scheduled.filter((d) => !doneDates.has(localDateStr(d)))
    return {
      name: h.name,
      scheduledCount: scheduled.length,
      doneCount: scheduled.length - missed.length,
      missedWeekdays: missed.map((d) => WEEKDAY_IT[mondayIndex(d)]),
    }
  })

  const successDays = pastOrToday.filter((d) => {
    const applicable = habits.filter((h) => !h.days || !h.days.length || h.days.includes(d.getDay()))
    if (!applicable.length) return true
    const key = localDateStr(d)
    return applicable.every((h) => habitDoneDatesOf(h).has(key))
  }).length

  const { year, week } = isoWeek(weekStart)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)

  return {
    year,
    week,
    startIso: localDateStr(weekStart),
    endIso: localDateStr(weekEnd),
    daysElapsed: pastOrToday.length,
    successDays,
    habits: perHabit,
  }
}

export function currentWeekSummary(habits, now = new Date()) {
  return summarizeWeek(habits, startOfWeek(now), now)
}

/** The last `count` weeks including the current one, newest first — the history Gemini's review context is built from. */
export function recentWeekSummaries(habits, now = new Date(), count = 8) {
  const out = []
  for (let i = 0; i < count; i++) {
    const ws = startOfWeek(now)
    ws.setDate(ws.getDate() - i * 7)
    out.push(summarizeWeek(habits, ws, now))
  }
  return out
}

/** One week's summary as plain text for Gemini's context — readable, not JSON, since it only ever needs to be read, not parsed back. */
export function formatWeekSummary(w) {
  const lines = w.habits.map((h) => {
    const missed = h.missedWeekdays.length ? ` (mancata: ${h.missedWeekdays.join(', ')})` : ''
    return `  - ${h.name}: ${h.doneCount}/${h.scheduledCount}${missed}`
  })
  return (
    `Settimana ${w.week}/${w.year} (${w.startIso} – ${w.endIso}), ` +
    `${w.successDays}/${w.daysElapsed} giorni riusciti finora:\n` +
    (lines.length ? lines.join('\n') : '  (nessuna abitudine configurata)')
  )
}
