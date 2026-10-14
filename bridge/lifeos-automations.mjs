/**
 * The home page's AUTOMAZIONI card used to show three made-up examples.
 * These are the real ones — every cron job and systemd timer hermes-agent
 * (the Telegram-facing half of the same assistant) already runs on the Pi,
 * including whatever Claude has created for itself through lifeos-cron.mjs.
 * Read-only: this reports what cron/systemctl say, it never writes to
 * either, so there's no risk of a stray click disabling a real job.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { HERMES_DIR, commandFor, parseCrontab, readCrontabText, writeCrontabText } from './cron-utils.mjs'

const execFileAsync = promisify(execFile)

// Hand-written labels for the jobs that predate lifeos-cron.mjs and so carry
// no `# jarvis:` comment of their own — matched by module name. Anything
// else found in the crontab (including new ones Claude schedules from here
// on, which DO carry a comment) is described from that comment instead.
const KNOWN_LABELS = {
  morning_briefing: {
    time: 'OGNI GIORNO · 06:00',
    action: 'Resoconto del mattino: meteo, impegni e cosa serve sapere per iniziare la giornata',
  },
  market_news_watch: {
    time: 'OGNI 30 MINUTI',
    action: "Sorveglianza notizie su Bitcoin e sull'indice MSCI World, avvisa su Telegram solo se rilevante",
  },
  etf_monthly_contribution: {
    time: 'IL 30 DI OGNI MESE · 09:00',
    action: "Registra il versamento mensile sull'ETF (20€ in quote al prezzo del giorno)",
  },
  printer_watch: {
    time: 'OGNI 5 MINUTI',
    action: 'Sorveglianza stampante 3D: avvisa su Telegram a stampa finita o fermata',
  },
  concorso_watch: {
    time: 'OGNI 6 ORE',
    action: 'Sorveglianza del concorso Esercito - Corpo Ingegneri (profilo ingegneria informatica)',
  },
}

// Timer-triggered systemd units — same idea, but their on/off and
// success/failure state is asked to systemd instead of grepped from a file.
const TIMER_UNITS = [
  {
    service: 'hermes-reminders.service',
    timer: 'hermes-reminders.timer',
    time: 'OGNI MINUTO',
    action: 'Invia su Telegram i promemoria scaduti',
  },
  {
    service: 'hermes-compact.service',
    timer: 'hermes-compact.timer',
    time: 'OGNI GIORNO · 03:30',
    action: 'Compatta la memoria di Hermes (estrae i fatti rilevanti con Gemini)',
  },
]

/** `systemctl is-active <timer>` — true only on "active". */
async function timerActive(timer) {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', timer])
    return stdout.trim() === 'active'
  } catch {
    return false
  }
}

/** `systemctl is-failed <service>` exits 0 (prints "failed") only when it is. */
async function serviceFailed(service) {
  try {
    await execFileAsync('systemctl', ['is-failed', service])
    return true
  } catch {
    return false
  }
}

/** First non-blank line of the module's own docstring — the last-resort description for a job with neither a KNOWN_LABELS entry nor a `# jarvis:` comment. */
function docstringFallback(module) {
  try {
    const src = readFileSync(`${HERMES_DIR}/harness/${module}.py`, 'utf8')
    const m = /"""\s*\n?\s*([^\n]+)/.exec(src)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

const WEEKDAYS_IT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato']

/** Turns a 5-field cron schedule into the Italian label the card already used for the known jobs — falls back to the raw expression for anything it doesn't recognize. */
function humanizeSchedule(schedule) {
  const [min, hour, dom, , dow] = schedule.trim().split(/\s+/)
  const hhmm = (h, m) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`

  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && dow === '*') {
    return `OGNI ${min.slice(2)} MINUTI`
  }
  if (min === '0' && /^\*\/\d+$/.test(hour) && dom === '*' && dow === '*') {
    return `OGNI ${hour.slice(2)} ORE`
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && dow === '*') {
    return `OGNI GIORNO · ${hhmm(hour, min)}`
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom)) {
    return `IL ${dom} DI OGNI MESE · ${hhmm(hour, min)}`
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && /^\d+$/.test(dow)) {
    return `OGNI ${WEEKDAYS_IT[Number(dow) % 7].toUpperCase()} · ${hhmm(hour, min)}`
  }
  if (min === '*' && hour === '*' && dom === '*' && dow === '*') return 'OGNI MINUTO'
  return schedule.trim()
}

export async function listAutomations() {
  const { jobs } = parseCrontab(await readCrontabText())

  const fromCron = jobs.map((job) => ({
    id: `cron-${job.module}`,
    time: humanizeSchedule(job.schedule),
    action: job.description || KNOWN_LABELS[job.module]?.action || docstringFallback(job.module) || `Esegue harness.${job.module}`,
    enabled: job.enabled,
    failed: false,
    real: true,
    editable: true, // cron jobs can be paused/resumed — see setAutomationEnabled
  }))

  const fromTimers = await Promise.all(
    TIMER_UNITS.map(async (unit, i) => {
      const [enabled, failed] = await Promise.all([
        timerActive(unit.timer),
        serviceFailed(unit.service),
      ])
      return {
        id: `timer-${i}`,
        time: unit.time,
        action: unit.action,
        enabled,
        failed,
        real: true,
      }
    }),
  )

  return [...fromCron, ...fromTimers]
}

/**
 * Pauses or resumes one cron automation by commenting/uncommenting its line — the same edit
 * update_cron_job makes (lifeos-cron.mjs), and writeCrontabText takes a timestamped backup first.
 * Only `cron-<module>` ids: the systemd timers need root, so they stay read-only.
 */
export async function setAutomationEnabled(id, enabled) {
  const m = /^cron-([a-z][a-z0-9_]*)$/.exec(String(id))
  if (!m) throw Object.assign(new Error('Questa automazione non è modificabile da qui.'), { status: 400 })
  const { lines, jobs } = parseCrontab(await readCrontabText())
  const job = jobs.find((j) => j.module === m[1])
  if (!job) throw Object.assign(new Error('Automazione non trovata.'), { status: 404 })
  if (job.enabled !== !!enabled) {
    lines[job.commandLine] = `${enabled ? '' : '# '}${job.schedule} ${commandFor(job.module)}`
    await writeCrontabText(lines.join('\n'))
  }
  return { id, enabled: !!enabled }
}
