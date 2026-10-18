/**
 * The four actions the local model (Qwen2.5, via runLocalModel in
 * server.mjs) can actually perform on LifeOS — as opposed to just talking
 * about performing them. Each tool's `run` touches lifeos-store.mjs for
 * real, and `confirm` builds the reply from the record that was actually
 * written, not from anything the model said — so a confirmation is never
 * shown unless the write genuinely happened.
 *
 * Which tools a section's assistant is offered is deliberately narrow: the
 * Finanze chat can add a transaction but not a meal, and so on. "home" (the
 * general bar on the Home page) gets all four, matching its own placeholder
 * text ("aggiungi un evento, controlla il mercato, registra una spesa…").
 */

import { addMeal, addReminder, addTransaction, getStore } from './lifeos-store.mjs'
import { buildCatalog } from './lifeos-finance-catalog.mjs'
import { createEvent, createEventInCalendar, listCalendarNames } from './lifeos-caldav.mjs'
import { parseItalianWhen } from './lifeos-datetime.mjs'

/**
 * Thrown when the model called a tool but the arguments don't look like a
 * real action (a zero amount, an empty name, a placeholder-looking string).
 * Caught in server.mjs's runLocalModel to turn into a clarifying question
 * instead of a persisted record — see the "quanto ho speso questo mese?"
 * incident: without this, that question got classified as add_transaction
 * with amount=0, category="Totale Spese", and silently written to disk.
 */
export class ActionValidationError extends Error {}

const isBlank = (s) => !s || !String(s).trim() || /^(n\/?a|none|nessuno?|non\s*so|totale|sconosciut[oa])$/i.test(String(s).trim())
const formatIt = (iso) =>
  new Date(iso).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

// The calendars the model may pick from. Fetched from iCloud (not hard-coded,
// so a calendar added on the phone shows up) and cached for ten minutes;
// toolsForSection / systemPromptFor stay synchronous and read the cache.
let calendarNames = []
let calendarsFetchedAt = 0
export async function refreshCalendarNames() {
  if (calendarNames.length && Date.now() - calendarsFetchedAt < 10 * 60_000) return
  try {
    calendarNames = await listCalendarNames()
    calendarsFetchedAt = Date.now()
  } catch (err) {
    console.error('[lifeos-tools] calendar list failed:', err?.message ?? err)
  }
}
// Accounts and custom categories the model may name, read from the store before
// each request (cheap: it is a local file) so a new one is usable at once.
let accountNames = []
let customCategories = []
export async function refreshFinanceContext() {
  try {
    const store = await getStore()
    accountNames = (store.accounts ?? []).map((a) => a.name).filter(Boolean)
    customCategories = store.categories ?? []
  } catch (err) {
    console.error('[lifeos-tools] finance context failed:', err?.message ?? err)
  }
}
const matchAccount = (name) => (isBlank(name) ? '' : accountNames.find((a) => a.toLowerCase() === String(name).trim().toLowerCase()) ?? '')

const matchCalendar = (name) => (isBlank(name) ? null : calendarNames.find((c) => c.toLowerCase() === String(name).trim().toLowerCase()) ?? null)

const TOOLS = {
  add_transaction: {
    def: {
      type: 'function',
      function: {
        name: 'add_transaction',
        description: "Registra UNA NUOVA spesa o entrata di denaro che l'utente sta segnalando ora. Non usare per domande su spese passate o totali.",
        parameters: {
          type: 'object',
          properties: {
            tx_type: { type: 'string', enum: ['spesa', 'entrata'] },
            amount: { type: 'number' },
            category: { type: 'string', description: 'Categoria. Usa una di quelle elencate nel prompt se ce n\'è una adatta; solo se nessuna va bene, proponi un nome breve nuovo.' },
            description: { type: 'string', description: 'Descrizione breve di cosa è (es. "Spesa Esselunga", "Pizza con Anna", "Rata telefono"). Vuoto se la frase non dice nulla di più della categoria.' },
            account: { type: 'string', description: 'Nome del conto, solo se l\'utente lo indica o è inequivocabile; deve essere uno dei conti elencati. Altrimenti vuoto.' },
            date: { type: 'string', description: 'Giorno del movimento, formato "YYYY-MM-DD", solo se non è oggi (es. "ieri", "il 12"). Vuoto = oggi.' },
          },
          required: ['tx_type', 'amount', 'category'],
        },
      },
    },
    validate: (a) => Number(a.amount) > 0 && !isBlank(a.category) && ['spesa', 'entrata'].includes(a.tx_type),
    run: (a) => addTransaction({ ...a, account: matchAccount(a.account) }),
    confirm: (r) => {
      const day = new Date(r.date)
      const today = new Date()
      const dayLabel = day.toDateString() === today.toDateString() ? '' : ` del ${day.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}`
      return `Registrata ${r.type === 'entrata' ? "un'entrata" : 'una spesa'}${dayLabel} di €${r.amount} — ${r.category}` +
        `${r.description ? ` («${r.description}»)` : ''}${r.account ? `, conto ${r.account}` : ''}.`
    },
  },
  add_meal: {
    def: {
      type: 'function',
      function: {
        name: 'add_meal',
        description: 'Registra UN NUOVO pasto che l’utente ha appena consumato o sta per consumare. Non usare per domande sui pasti già registrati.',
        parameters: {
          type: 'object',
          properties: {
            meal_name: { type: 'string' },
            kcal: { type: 'number' },
          },
          required: ['meal_name', 'kcal'],
        },
      },
    },
    validate: (a) => Number(a.kcal) > 0 && !isBlank(a.meal_name),
    run: addMeal,
    confirm: (r) => `Registrato il pasto "${r.name}" — ${r.kcal} kcal.`,
  },
  add_event: {
    def: {
      type: 'function',
      function: {
        name: 'add_event',
        description: 'Aggiunge UN NUOVO evento o appuntamento al calendario Apple. Non usare per domande sugli eventi esistenti.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: "Titolo breve e naturale dell'evento, ricavato dalla frase (es. «Dentista», «Riunione con Marco»). Non includere data, ora o luogo." },
            start: { type: 'string', description: 'Inizio in ora locale italiana, formato ISO "YYYY-MM-DDTHH:MM" (es. "2026-11-17T08:00"). Calcolalo tu usando la data di oggi e il calendario fornito.' },
            end: { type: 'string', description: 'Fine in ora locale, stesso formato di start. Per intervalli come "8-12", "dalle 8 alle 12", "8:00–12:00" è la seconda ora. Se la frase dà una durata ("per due ore") calcola end = start + durata. Se non c\'è né fine né durata, lascialo vuoto (verrà usata 1 ora).' },
            location: { type: 'string', description: 'Luogo, se citato (es. "Torino", "studio del dentista", "via Roma 5"). Vuoto se non indicato.' },
            notes: { type: 'string', description: 'Altri dettagli utili citati nella frase che non sono titolo, orario o luogo. Vuoto se non ce ne sono.' },
            alerts_minutes_before: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Promemoria/avvisi dell\'evento, ciascuno in minuti PRIMA dell\'inizio (0 = all\'ora dell\'evento; 60 = un\'ora prima; 1440 = un giorno prima). Solo se l\'utente chiede un promemoria/avviso/"ricordamelo"; altrimenti non includerlo. Massimo 5.',
            },
            // Fallback only — kept so a weaker model that can't produce
            // ISO datetimes still works through lifeos-datetime.mjs.
            when_text: { type: 'string', description: 'Solo se non riesci a calcolare start: la parte della frase che indica quando inizia, alla lettera.' },
            until_text: { type: 'string', description: 'Solo se non riesci a calcolare end: la parte della frase che indica quando finisce, alla lettera.' },
          },
          required: ['title'],
        },
      },
    },
    validate: (a) => !isBlank(a.title) && (!isBlank(a.start) || !isBlank(a.when_text)),
    run: async ({ title, start, end, when_text, until_text, duration_minutes, location, notes, calendar, alerts_minutes_before }) => {
      const alertsMinutes = Array.isArray(alerts_minutes_before) ? alerts_minutes_before : []
      const calendarName = matchCalendar(calendar)
      const create = (o) => (calendarName ? createEventInCalendar({ calendarName, ...o, endIso: new Date(new Date(o.startIso).getTime() + o.durationMinutes * 60_000).toISOString() }) : createEvent(o))
      // Preferred path: the model resolved the datetimes itself (Groq is
      // reliable at this, unlike the 3B model this file was first built
      // around). Local-time ISO strings with no zone parse as the bridge's
      // own local time, which is Europe/Rome here.
      const parseLocal = (v) => {
        if (isBlank(v)) return null
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v).trim())
        if (!m) return null
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 9), Number(m[5] ?? 0), 0, 0)
        return Number.isNaN(d.getTime()) ? null : d
      }
      const startDate = parseLocal(start)
      if (startDate) {
        let endDate = parseLocal(end)
        if (endDate && endDate <= startDate) {
          // "22-02" style: the end is past midnight and the model forgot the day.
          const bumped = new Date(endDate.getTime() + 86_400_000)
          endDate = bumped > startDate && bumped - startDate <= 24 * 3_600_000 ? bumped : null
        }
        const mins = endDate ? Math.round((endDate - startDate) / 60_000) : Number(duration_minutes) > 0 ? Number(duration_minutes) : 60
        const rec = await create({ title, startIso: startDate.toISOString(), durationMinutes: mins, location: location || '', notes: notes || '', alertsMinutes })
        return { ...rec, durationMinutes: mins }
      }
      // until_text sometimes turns out to hold what's actually the START
      // time — the model splits "domani alle 16" into when_text="domani",
      // until_text="alle 16" just as readily as it splits a bare "15" off
      // "il 30/09 alle 15". Both share one signature: until_text is NOTHING
      // but a bare time — no "del", no weekday, no "domani", no date of its
      // own — while when_text has no time of its own to lose. When that's
      // true, until_text isn't describing an end at all; fold it back in.
      // Harmless if when_text already had a time: parseItalianWhen only
      // reads the first "alle …" it finds.
      const BARE_TIME = /^\s*(?:alle\s+)?(\d{1,2}(?:[:.]\d{2})?)\s*$/i
      const HAS_TIME = /alle\s+\d{1,2}|\b\d{1,2}[:.]\d{2}\b/i
      const bareTimeMatch = BARE_TIME.exec(String(until_text ?? ''))
      if (bareTimeMatch && !HAS_TIME.test(String(when_text ?? ''))) {
        when_text = `${when_text} alle ${bareTimeMatch[1]}`
        until_text = null
      }
      const startIso = parseItalianWhen(when_text)
      if (!startIso) {
        throw new ActionValidationError(`Non ho capito quando: puoi dirmi giorno e ora in modo più preciso?`)
      }
      let durationMinutes = Number(duration_minutes) || 60
      if (!isBlank(until_text)) {
        // Parsed relative to the event's own start date, not to "now" — so a
        // bare "alle 2" (no date of its own) lands on the start's calendar
        // day rather than today's.
        let endIso = parseItalianWhen(until_text, new Date(startIso))
        if (!endIso) {
          throw new ActionValidationError(`Non ho capito quando finisce: puoi dirmi orario e giorno in modo più preciso?`)
        }
        // An end time with no date of its own that lands before the start
        // (e.g. start 18:00, end phrase "alle 2" resolves to 02:00 the SAME
        // day) means it crosses midnight — roll it to the next day.
        if (new Date(endIso) <= new Date(startIso)) {
          endIso = new Date(new Date(endIso).getTime() + 24 * 60 * 60 * 1000).toISOString()
        }
        durationMinutes = Math.round((new Date(endIso) - new Date(startIso)) / 60_000)
      }
      const record = await create({ title, startIso, durationMinutes, location: location || '', notes: notes || '', alertsMinutes })
      return { ...record, durationMinutes }
    },
    confirm: (r) => {
      const end = new Date(new Date(r.startIso).getTime() + r.durationMinutes * 60_000)
      const endLabel = end.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
      return `Evento "${r.title}" aggiunto sul calendario Apple${r.calendar ? ' «' + r.calendar + '»' : ''} — ${formatIt(r.startIso)} fino alle ${endLabel}${r.location ? ' (' + r.location + (r.geo ? ' · trovato sulla mappa' : '') + ')' : ''}${r.alerts?.length ? ' — avviso ' + r.alerts.map((m) => (m === 0 ? "all'ora dell'evento" : m % 1440 === 0 ? `${m / 1440} g prima` : m % 60 === 0 ? `${m / 60} h prima` : `${m} min prima`)).join(', ') : ''}.`
    },
  },
  add_reminder: {
    def: {
      type: 'function',
      function: {
        name: 'add_reminder',
        description: 'Aggiunge UN NUOVO promemoria su LifeOS. Non usare per domande sui promemoria esistenti.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            when_text: { type: 'string', description: 'La parte della frase che indica quando, presa alla lettera (es. "lunedì", "domani"), oppure vuoto se non specificato' },
          },
          required: ['text'],
        },
      },
    },
    validate: (a) => !isBlank(a.text),
    run: ({ text, when_text }) => {
      let dueIso = null
      if (!isBlank(when_text)) {
        dueIso = parseItalianWhen(when_text)
        if (!dueIso) {
          throw new ActionValidationError(`Non ho capito quando: puoi dirmi giorno e ora in modo più preciso, o dirmi di non impostare una scadenza?`)
        }
      }
      return addReminder({ text, due_iso: dueIso })
    },
    confirm: (r) => `Promemoria aggiunto su LifeOS: "${r.text}"${r.when ? ' — ' + formatIt(r.when) : ''}.`,
  },
}

const SECTION_TOOLS = {
  finanze: ['add_transaction'],
  salute: ['add_meal'],
  review: ['add_reminder'],
  home: ['add_transaction', 'add_meal', 'add_event', 'add_reminder'],
}

function financePrompt() {
  const { categories } = buildCatalog(customCategories)
  const by = (kind) => categories.filter((c) => c.kind === kind).map((c) => c.name).join(', ')
  return ` Categorie di spesa: ${by('spesa')}. Categorie di entrata: ${by('entrata')}.` +
    (accountNames.length ? ` Conti disponibili: ${accountNames.join(', ')}.` : '')
}

export function toolsForSection(section) {
  return (SECTION_TOOLS[section] ?? []).map((name) => {
    const def = TOOLS[name].def
    if (name !== 'add_event' || !calendarNames.length) return def
    const copy = JSON.parse(JSON.stringify(def))
    copy.function.parameters.properties.calendar = {
      type: 'string',
      enum: calendarNames,
      description: `Calendario in cui mettere l'evento, uno tra: ${calendarNames.join(', ')}. Scegli in base al contesto (lavoro → Work, casa/famiglia → Home) o a quello che dice l'utente; se non è chiaro lascia vuoto e verrà usato quello predefinito.`,
    }
    return copy
  })
}

/**
 * The clock line used to sit first, inside the very first sentence — and
 * that alone was most of why this Pi felt so slow. llama.cpp's prompt cache
 * reuses tokens only up to the point two prompts first diverge, and every
 * single request differs somewhere near the start (the wall-clock time) once
 * a minute goes by. Measured cost of that: an identical prompt sent a minute
 * apart, cache cold, took 87s; sent again within the round window below, warm
 * cache, took 17s — the tool schemas and instructions are the bulk of the
 * tokens, and they're identical every time. So the stable, static part goes
 * first now, and only the clock — rounded to a 15-minute window, so repeat
 * questions in the same stretch still hit the cache — goes at the end.
 * Precision there doesn't matter for correctness: the model only ever copies
 * a phrase like "stasera" or "alle 18" verbatim (see when_text/until_text
 * below), it never computes a final date itself.
 */
export function systemPromptFor(section) {
  const now = new Date()
  const today = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
  const rounded = new Date(now)
  rounded.setMinutes(Math.floor(rounded.getMinutes() / 15) * 15, 0, 0)
  const time = rounded.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })

  const persona = `Sei l'assistente di LifeOS. Rispondi sempre in italiano, breve, in una frase.`
  // A calendar for the next two weeks, so "venerdì" or "il 17" never needs
  // weekday arithmetic from the model.
  const days = []
  for (let i = 0; i < 14; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    days.push(`${d.toLocaleDateString('sv-SE')} ${d.toLocaleDateString('it-IT', { weekday: 'short' })}`)
  }
  const toolRules = SECTION_TOOLS[section]?.length
    ? ' Hai a disposizione delle funzioni: usale quando il messaggio chiede di registrare, aggiungere o segnare qualcosa di nuovo (una spesa, un pasto, un evento, un promemoria). ' +
      'Interpreta liberamente il linguaggio naturale: l\'utente scrive in modo informale, con abbreviazioni, intervalli ("8-12", "dalle 8 alle 12", "h 15"), giorni relativi ("giovedì prossimo", "tra due settimane", "il 17 novembre") e luoghi in qualunque posizione della frase. Ricava tu tutti i parametri dal contesto, senza chiedere conferme inutili. ' +
      'Per gli eventi: calcola tu "start" ed "end" in ora locale italiana, formato "YYYY-MM-DDTHH:MM". Un intervallo "8-12" significa 08:00–12:00, "14-16" 14:00–16:00; con "mattina/pomeriggio/sera" scegli l\'ora più plausibile. Se l\'anno non è indicato usa la prossima occorrenza della data (mai nel passato). Se manca l\'ora ma è chiaramente un impegno di una giornata intera, usa 09:00–18:00. Se l\'utente chiede un promemoria/avviso per l\'evento ("avvisami un\'ora prima", "ricordamelo il giorno prima") usa "alerts_minutes_before" (60, 1440…). Il calendario va in "calendar" solo se l\'utente lo nomina o il contesto è inequivocabile. Il luogo ("a Torino", "da Marco") va in "location", il titolo resta breve e senza data/ora/luogo. ' +
      'Se una richiesta contiene più azioni (es. due eventi), chiama la funzione più volte. ' +
      'Non chiamare funzioni per domande o richieste di informazioni su dati già esistenti ("quanto ho speso", "che eventi ho"): rispondi spiegando che non hai accesso allo storico. ' +
      'Chiedi chiarimenti SOLO se manca un dato davvero essenziale e non deducibile (es. nessuna data per un evento, nessun importo per una spesa), con una domanda sola e breve.'
    : ''
  const todayFull = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return `${persona}${toolRules} Oggi è ${todayFull}, sono circa le ${time} (fuso orario Europe/Rome).` +
    (SECTION_TOOLS[section]?.length ? ` Calendario dei prossimi giorni: ${days.join(', ')}.` : '') +
    (SECTION_TOOLS[section]?.some((t) => t === 'add_transaction') ? financePrompt() : '') +
    (SECTION_TOOLS[section]?.length && calendarNames.length ? ` Calendari Apple disponibili: ${calendarNames.join(', ')} (predefinito: Calendar; «Verifiche» è riservato alle verifiche scolastiche).` : '')
}

/**
 * Runs one tool call, returning both the confirmation text and the raw
 * record — but only after `validate` passes. A call with a missing or
 * clearly-invalid argument (amount 0, blank name, "totale"/"nessuno" as a
 * category) throws ActionValidationError instead of writing anything: better
 * a clarifying question than a fabricated record on disk.
 */
export async function runTool(name, args) {
  const tool = TOOLS[name]
  if (!tool) throw new Error(`azione sconosciuta: ${name}`)
  if (!tool.validate(args ?? {})) {
    throw new ActionValidationError(
      `Non ho abbastanza informazioni per farlo: mi servono dati più precisi (es. importo, nome, orario).`,
    )
  }
  const record = await tool.run(args ?? {})
  return { record, confirm: tool.confirm(record), action: name }
}
