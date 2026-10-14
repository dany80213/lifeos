/**
 * Apple Calendar and Reminders, for real — via iCloud's CalDAV server. Same
 * account and app-specific password already used by hermes-agent's own
 * harness/apple_calendar.py (reused rather than re-issued, per instruction).
 *
 * iCloud exposes both calendars (VEVENT) and reminder lists (VTODO) as CalDAV
 * collections on the same account; which is which is read off each
 * collection's `components` field. "Turni" (work shifts) is excluded from
 * the readable calendars for the same reason apple_calendar.py excludes it:
 * they aren't personal appointments and Daniele doesn't want them mixed in.
 */

import { DAVClient } from 'tsdav'

const EXCLUDED_CALENDARS = new Set(['Turni'])
const DEFAULT_CALENDAR_NAME = 'Calendar'

// Read lazily, not at module-load time: this module is imported (via
// lifeos-tools.mjs) before server.mjs's own loadEnvLocal() has populated
// process.env from .env.local — ES module bodies all run before the
// importing script's top-level code does. A module-level `const APPLE_ID =
// process.env.APPLE_ID` here would permanently cache `undefined`.
let clientPromise = null
function getClient() {
  const APPLE_ID = process.env.APPLE_ID || null
  const APPLE_APP_PASSWORD = process.env.APPLE_APP_PASSWORD || null
  if (!APPLE_ID || !APPLE_APP_PASSWORD) {
    throw new Error('Apple Calendar/Reminders non configurati (APPLE_ID/APPLE_APP_PASSWORD).')
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new DAVClient({
        serverUrl: 'https://caldav.icloud.com',
        credentials: { username: APPLE_ID, password: APPLE_APP_PASSWORD },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      })
      await client.login()
      return client
    })().catch((err) => {
      clientPromise = null // let the next call retry rather than staying broken forever
      throw err
    })
  }
  return clientPromise
}

async function calendars() {
  const client = await getClient()
  return client.fetchCalendars()
}

const isEventCalendar = (cal) => (cal.components ?? ['VEVENT']).includes('VEVENT') && !EXCLUDED_CALENDARS.has(cal.displayName)

async function defaultEventCalendar() {
  const cals = (await calendars()).filter(isEventCalendar)
  if (!cals.length) throw new Error('Nessun calendario Apple leggibile trovato.')
  return cals.find((c) => c.displayName === DEFAULT_CALENDAR_NAME) ?? cals[0]
}

const uid = () => `lifeos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@lifeos`
const icsEscape = (s) => String(s ?? '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
// CalDAV wants floating local time as YYYYMMDDTHHMMSS, no offset — matches
// how apple_calendar.py hands datetimes to the caldav library.
const toICalTime = (iso) => {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// Inverse of toICalTime: "20260925T180000" (optionally Z-suffixed for a
// UTC-anchored event) -> a proper ISO string. A bare YYYYMMDDTHHMMSS with no
// Z is floating/local time — the same convention this file's own writes use
// — so it's returned with no zone designator, which JS parses as local time.
function icalToIso(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/.exec(raw ?? '')
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', se = '00', z] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${z ? 'Z' : ''}`
}

/** The event calendars Daniele can actually read — for a "which calendars" filter UI. */
export async function listCalendarNames() {
  return (await calendars()).filter(isEventCalendar).map((c) => c.displayName)
}

export async function listEvents(daysAhead = 14) {
  const client = await getClient()
  const start = new Date()
  const end = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000)
  const todayStamp = toICalTime(start.toISOString())
  const out = []
  for (const cal of (await calendars()).filter(isEventCalendar)) {
    const objects = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: start.toISOString(), end: end.toISOString() },
      // Without this, a recurring event comes back as its master instance —
      // original DTSTART and all, even years in the past — instead of the
      // occurrence that actually falls in this range.
      expand: true,
    })
    for (const obj of objects) {
      const summary = /SUMMARY:(.*)/.exec(obj.data ?? '')?.[1]?.trim()
      const dtstart = /DTSTART[^:]*:(\S*)/.exec(obj.data ?? '')?.[1]
      const dtend = /DTEND[^:]*:(\S*)/.exec(obj.data ?? '')?.[1]
      const location = /LOCATION:(.*)/.exec(obj.data ?? '')?.[1]?.trim()
      // Belt-and-suspenders against a handful of recurring events whose
      // master instance still leaks through the server's own expansion
      // (observed on this account: a years-old recurring event repeated as
      // its original 2023 dates instead of an upcoming occurrence).
      if (summary && dtstart && dtstart >= todayStamp) {
        out.push({
          title: summary, start: dtstart, startIso: icalToIso(dtstart),
          endIso: dtend ? icalToIso(dtend) : null,
          location: location ?? '', calendar: cal.displayName,
        })
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}


// --- Location → coordinates ------------------------------------------------
// Done here in the bridge with OpenStreetMap's Nominatim, NOT by the model, so
// it costs no Groq tokens. Best effort: any failure just means the event keeps
// a plain-text LOCATION, exactly like before.
const geoCache = new Map()
// Words that name no place a map could find.
const VAGUE_PLACE = /^(?:in\s+)?(?:la\s+|il\s+|lo\s+)?(?:sede|casa|ufficio|studio|lavoro|qui|l[iì]|online|zoom|meet|teams|telefono|da\s+me|da\s+noi|home|office)$/i

async function geocodePlace(text) {
  const q = String(text ?? '').trim()
  if (q.length < 3 || VAGUE_PLACE.test(q)) return null
  const key = q.toLowerCase()
  if (geoCache.has(key)) return geoCache.get(key)
  let hit = null
  try {
    for (const extra of ['&countrycodes=it', '']) {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=it&q=${encodeURIComponent(q)}${extra}`,
        { headers: { 'user-agent': 'LifeOS-jarvis3 (personal calendar assistant)' }, signal: AbortSignal.timeout(4000) },
      )
      if (!res.ok) break
      const rows = await res.json()
      if (rows?.[0]?.lat && rows[0].lon) {
        hit = { lat: Number(rows[0].lat), lon: Number(rows[0].lon), address: String(rows[0].display_name ?? q) }
        break
      }
    }
  } catch (err) {
    console.error('[lifeos-caldav] geocode failed:', err?.message ?? err)
  }
  if (hit && !(Number.isFinite(hit.lat) && Number.isFinite(hit.lon))) hit = null
  geoCache.set(key, hit)
  return hit
}

export async function createEvent({ title, startIso, durationMinutes = 60, location = '', notes = '', alertsMinutes = [] }) {
  const cal = await defaultEventCalendar()
  return createEventInCalendar({
    calendarName: cal.displayName, title, startIso,
    endIso: new Date(new Date(startIso).getTime() + durationMinutes * 60_000).toISOString(),
    location, notes, alertsMinutes,
  })
}

/** Same write path as createEvent, but targets a named calendar (must already
 * exist — this never creates one) and takes an explicit end time and notes. */
export async function createEventInCalendar({ calendarName, title, startIso, endIso, location = '', notes = '', alertsMinutes = [] }) {
  const client = await getClient()
  const cals = (await calendars()).filter(isEventCalendar)
  const cal = cals.find((c) => c.displayName === calendarName)
  if (!cal) throw new Error(`Calendario "${calendarName}" non trovato tra quelli leggibili.`)
  const dtStart = toICalTime(startIso)
  const dtEnd = toICalTime(endIso ?? new Date(new Date(startIso).getTime() + 60 * 60_000).toISOString())
  const stamp = toICalTime(new Date().toISOString())
  const geo = location ? await geocodePlace(location) : null
  const alarms = [...new Set((alertsMinutes ?? []).map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 60 * 24 * 60))].slice(0, 5)
  const id = uid()
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LifeOS//jarvis3.0//IT',
    'BEGIN:VEVENT',
    `UID:${id}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(title)}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    // Structured location: what makes Apple Calendar show the map pin and work
    // out travel time. Quotes would end the parameter early, so strip them.
    geo ? `GEO:${geo.lat};${geo.lon}` : null,
    geo
      ? `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="${geo.address.replace(/["\r\n]/g, ' ')}";X-APPLE-RADIUS=70;X-TITLE="${String(location).replace(/["\r\n]/g, ' ')}":geo:${geo.lat},${geo.lon}`
      : null,
    notes ? `DESCRIPTION:${icsEscape(notes)}` : null,
    // One display alert per entry: minutes BEFORE the start (0 = at start time).
    ...alarms.flatMap((m) => [
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)}`,
      `TRIGGER:${m === 0 ? 'PT0S' : `-PT${m}M`}`, 'END:VALARM',
    ]),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n')
  const res = await client.createCalendarObject({ calendar: cal, iCalString: ics, filename: `${id}.ics` })
  if (!res.ok) throw new Error(`iCloud ha risposto ${res.status} creando l'evento.`)
  return { title, start: dtStart, startIso, endIso, location, notes, alerts: alarms, geo: geo ? { lat: geo.lat, lon: geo.lon, address: geo.address } : null, calendar: cal.displayName }
}

/**
 * Every event on a single calendar day (local time), across every readable
 * calendar except the ones named in `excludeCalendars` — used to both find an
 * existing lesson's time slot (see lifeos-didup.mjs) and to check whether an
 * event already exists before creating a new one (dedup).
 */
export async function listEventsOnDate(dateIso, { excludeCalendars = [] } = {}) {
  const client = await getClient()
  const dayStart = new Date(dateIso); dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
  const out = []
  for (const cal of (await calendars()).filter(isEventCalendar)) {
    if (excludeCalendars.includes(cal.displayName)) continue
    const objects = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: dayStart.toISOString(), end: dayEnd.toISOString() },
      expand: true,
    })
    for (const obj of objects) {
      const summary = /SUMMARY:(.*)/.exec(obj.data ?? '')?.[1]?.trim()
      const dtstart = /DTSTART[^:]*:(\S*)/.exec(obj.data ?? '')?.[1]
      const dtend = /DTEND[^:]*:(\S*)/.exec(obj.data ?? '')?.[1]
      if (summary && dtstart) {
        out.push({
          title: summary, startIso: icalToIso(dtstart), endIso: dtend ? icalToIso(dtend) : null,
          calendar: cal.displayName,
        })
      }
    }
  }
  return out.sort((a, b) => (a.startIso ?? '').localeCompare(b.startIso ?? ''))
}

/** Each readable calendar's own iCloud color (e.g. "#1BADF8FF"), for coloring events by which calendar they're on. */
export async function listCalendarColors() {
  const cals = (await calendars()).filter(isEventCalendar)
  const out = {}
  for (const c of cals) out[c.displayName] = c.calendarColor || null
  return out
}

// Reminders do NOT go through CalDAV — see the note at the top of
// lifeos-store.mjs. This account's reminders were silently upgraded to
// Apple's newer on-device format at some point, which orphaned the single
// CalDAV-visible reminders list: writes succeeded, but nothing written there
// ever showed up in the real Reminders app. lifeos-store.mjs's addReminder
// is the real write path now.
