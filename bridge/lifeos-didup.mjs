/**
 * DidUp (registro elettronico Argo ScuolaNext), for LifeOS — via hermes-agent's
 * own FastAPI, not a fresh Argo login here. hermes-agent (harness/didup.py)
 * already owns the credentials and the Argo session-freshness workaround; this
 * just reads its /api/didup/* endpoints over loopback (same Raspberry Pi).
 *
 * Two jobs:
 *   - fetchVerifiche/fetchCompiti, for the LifeOS home cards (see server.mjs's
 *     /api/lifeos-data).
 *   - syncVerificheToCalendar, which turns the "verifica" reminders into real
 *     events on the "Verifiche" Apple calendar, timed to match the actual
 *     lesson slot already on Daniele's calendar (see lifeos-caldav.mjs).
 */

import { createEventInCalendar, listEventsOnDate } from './lifeos-caldav.mjs'

const DIDUP_API = process.env.DIDUP_API_URL || 'http://127.0.0.1:8420'
const VERIFICHE_CALENDAR = 'Verifiche'
const VERIFICHE_LOCATION = 'I.I.S J.C Maxwell Nichelino, TO'

async function getJson(path) {
  const res = await fetch(`${DIDUP_API}${path}`)
  if (!res.ok) throw new Error(`hermes-agent ${path} -> ${res.status}`)
  const data = await res.json()
  if (data && data.error) throw new Error(data.error)
  return data
}

/** Local calendar date, YYYY-MM-DD — the same shape the registry uses for `data`. */
function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Tests and homework whose day has passed are not shown anywhere (home cards, web and iOS); today's stay until the day is over. */
const notPast = (item) => !item.data || String(item.data).slice(0, 10) >= todayKey()

/** Upcoming tests, soonest first — for the home page's VERIFICHE card. */
export async function fetchVerifiche() {
  const verifiche = await getJson('/api/didup/verifiche')
  return verifiche.filter(notPast).sort((a, b) => a.data.localeCompare(b.data))
}

/** Homework by due date, soonest first — for the home page's COMPITI card. */
export async function fetchCompiti() {
  const compiti = await getJson('/api/didup/compiti')
  return compiti.filter(notPast).sort((a, b) => a.data.localeCompare(b.data))
}

// "L. MARZO" -> "MARZO" — matches how the school's own lesson calendar
// titles each slot ("MAT - MARZO L."), so this is what identifies the right
// lesson without needing to know each subject's abbreviation.
const surnameOf = (docente) => (docente || '').trim().split(/\s+/).pop() || ''

/** The test's own time from Argo ("HH:MM"), as local ISO strings like the calendar slots; null when missing or inverted. */
function argoTimes(v) {
  const ok = (t) => /^\d{2}:\d{2}$/.test(t || '')
  if (!ok(v.oraInizio) || !ok(v.oraFine) || v.oraFine <= v.oraInizio) return null
  return { startIso: `${v.data}T${v.oraInizio}:00`, endIso: `${v.data}T${v.oraFine}:00` }
}

/**
 * One sync pass: read today's verifiche from DidUp, skip the ones already on
 * the Verifiche calendar or with no identifiable subject/lesson slot, create
 * the rest. Safe to call repeatedly (e.g. on a timer) — dedup is by date +
 * subject, not by a stored sync log.
 */
export async function syncVerificheToCalendar() {
  const verifiche = await fetchVerifiche()
  const risultati = []
  for (const v of verifiche) {
    const materia = (v.materia || '').trim()
    if (!materia) {
      risultati.push({ ...v, esito: 'saltata: materia sconosciuta (docente non trovato nel registro)' })
      continue
    }
    let eventiDelGiorno
    try {
      eventiDelGiorno = await listEventsOnDate(v.data)
    } catch (err) {
      risultati.push({ ...v, esito: `errore lettura calendario: ${err.message}` })
      continue
    }
    // Sottostringa, non uguaglianza esatta: un evento creato a mano si chiama
    // spesso "Verifica di matematica", non solo "Matematica" come i nuovi.
    const giaPresente = eventiDelGiorno.some((e) => {
      if (e.calendar !== VERIFICHE_CALENDAR) return false
      const titolo = e.title.trim().toLowerCase()
      const mat = materia.toLowerCase()
      return titolo.includes(mat) || mat.includes(titolo)
    })
    if (giaPresente) {
      risultati.push({ ...v, esito: 'già presente' })
      continue
    }
    const surname = surnameOf(v.docente)
    const slot = surname
      ? eventiDelGiorno.find((e) => e.calendar !== VERIFICHE_CALENDAR && e.title.toUpperCase().includes(surname.toUpperCase()))
      : null
    // Orario: prima quello della lezione in calendario; se non c'è, quello che il docente
    // ha indicato su Argo (assente quando è "00:00"-"00:00", e allora hermes-agent lo lascia vuoto).
    let startIso = slot?.startIso
    let endIso = slot?.endIso
    let fonte = 'calendario'
    if (!startIso || !endIso) {
      const argo = argoTimes(v)
      if (!argo) {
        risultati.push({ ...v, esito: `saltata: nessuna lezione di ${v.docente || 'questo docente'} in calendario il ${v.data} e nessun orario su Argo` })
        continue
      }
      ;({ startIso, endIso } = argo)
      fonte = 'Argo'
    }
    try {
      await createEventInCalendar({
        calendarName: VERIFICHE_CALENDAR,
        title: materia,
        startIso,
        endIso,
        location: VERIFICHE_LOCATION,
        notes: v.testo || '',
      })
      risultati.push({ ...v, esito: `creata ${startIso}–${endIso} (orario da ${fonte})` })
    } catch (err) {
      risultati.push({ ...v, esito: `errore creazione: ${err.message}` })
    }
  }
  return risultati
}

/** Called once from server.mjs at startup — same plain-interval pattern as
 * recurring-buys.mjs. DidUp only refreshes its own dashboard every so often,
 * so 30 minutes is plenty; a failed pass just retries at the next tick. */
export function startVerificheSyncScheduler() {
  const run = () =>
    syncVerificheToCalendar()
      .then((risultati) => {
        const creati = risultati.filter((r) => r.esito.startsWith('creata'))
        if (creati.length) console.log(`[jarvis] Verifiche: ${creati.length} evento/i creato/i su iCloud.`)
      })
      .catch((err) => console.error('[jarvis] sync Verifiche fallito:', err?.message ?? err))
  run()
  setInterval(run, 30 * 60 * 1000)
}
