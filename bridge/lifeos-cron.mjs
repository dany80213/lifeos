/**
 * The `jarvis_cron` MCP server — how Claude turns "avvisami se succede X"
 * into a real, scheduled, running automation on this Pi, instead of either
 * improvising a raw `crontab -e` (one typo away from silently breaking
 * backup.sh or the ETF job sharing the same file) or just promising to
 * remember and never actually doing it.
 *
 * The division of labour: Claude still WRITES the watcher script itself
 * (Write/Edit, same as any other code — harness/market_news_watch.py and
 * harness/concorso_watch.py are the house style to follow: one `ask_hermes`
 * turn, judgement on what counts as worth a message, Telegram only when it
 * is). This tool only owns the mechanical, dangerous-if-handrolled part:
 * validating the module exists, validating the schedule, and writing the
 * crontab back out as a whole so nothing else in it is ever touched.
 *
 * Every job this writes is a fixed shape — `cd <hermes dir> && uv run
 * python -m harness.<module> >> <module>.log 2>&1` — built here from a
 * bare module name, never from a string the model hands in whole. That is
 * what makes add_cron_job safe to expose at all: there is no field anywhere
 * in its schema a prompt injection could turn into an arbitrary shell
 * command.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFile } from 'node:child_process'
import { z } from 'zod'
import {
  HERMES_DIR,
  UV_BIN,
  commandFor,
  isValidSchedule,
  parseCrontab,
  readCrontabText,
  scriptExists,
  writeCrontabText,
} from './cron-utils.mjs'

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const MODULE_RE = /^[a-z][a-z0-9_]*$/

function checkModuleName(module) {
  const m = String(module ?? '').trim()
  if (!MODULE_RE.test(m)) {
    return { error: `Nome modulo non valido: "${module}". Solo minuscole, cifre e underscore, es. "usa_iran_watch".` }
  }
  return { module: m }
}

async function findJob(module) {
  const text = await readCrontabText()
  const { jobs } = parseCrontab(text)
  return { text, jobs, job: jobs.find((j) => j.module === module) }
}

export function lifeosCronServer() {
  return createSdkMcpServer({
    name: 'jarvis_cron',
    version: '1.0.0',
    instructions:
      "Crea ed esegue automazioni VERE su questo Pi — non promesse, cron reali che girano senza supervisione. " +
      "Flusso corretto quando l'utente chiede una nuova automazione (es. 'avvisami se ci sono aggiornamenti " +
      "importanti sulla guerra USA-Iran'): 1) proponi un piano in conversazione (cosa controllare, ogni quanto, " +
      "cosa conta come 'importante', come notificare — guardati harness/market_news_watch.py o " +
      "harness/concorso_watch.py come modello: un turno di ask_hermes() che decide se vale la pena avvisare, " +
      "poi un messaggio Telegram solo se sì); 2) SOLO dopo che l'utente conferma esplicitamente il piano, scrivi " +
      "lo script con i tuoi strumenti normali (Write) dentro harness/<nome_modulo>.py; 3) testalo con " +
      "run_script_now e guarda l'output — non schedularlo mai alla cieca; 4) solo se il test non dà errori, " +
      "chiama add_cron_job per attivarlo davvero. Non chiamare mai add_cron_job senza che l'utente abbia detto " +
      "esplicitamente di procedere, e non senza aver prima testato lo script con run_script_now.",
    alwaysLoad: true,
    tools: [
      tool(
        'list_cron_jobs',
        "Elenca tutte le automazioni attualmente schedulate su questo Pi (cron), con orario, descrizione e se " +
          "sono attive. Usalo per capire cosa esiste già prima di proporre qualcosa di nuovo o di modificarlo.",
        {},
        async () => {
          const { jobs } = parseCrontab(await readCrontabText())
          if (!jobs.length) return ok('Nessuna automazione schedulata al momento.')
          const lines = jobs.map(
            (j) => `- ${j.module}: ${j.description || '(nessuna descrizione)'} — ${j.schedule}${j.enabled ? '' : ' [DISATTIVATA]'}`,
          )
          return ok(lines.join('\n'))
        },
      ),

      tool(
        'run_script_now',
        "Esegue UNA VOLTA, subito, lo script harness/<module>.py e restituisce output ed eventuali errori — " +
          "senza schedularlo. Usalo SEMPRE per verificare che un nuovo script funzioni prima di chiamare " +
          "add_cron_job: non schedulare mai qualcosa che non hai visto girare senza errori almeno una volta.",
        {
          module: z.string().describe("Nome del modulo, es. 'usa_iran_watch' per harness/usa_iran_watch.py."),
          timeout_seconds: z.number().optional().describe("Timeout in secondi, default 60, massimo 120."),
        },
        async (args) => {
          const { module, error } = checkModuleName(args.module)
          if (error) return refuse(error)
          if (!scriptExists(module)) {
            return refuse(`Non trovato: harness/${module}.py non esiste. Scrivilo prima con i tuoi strumenti normali.`)
          }
          const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 120) * 1000
          try {
            const { stdout, stderr } = await new Promise((resolve, reject) => {
              execFile(
                UV_BIN,
                ['run', 'python', '-m', `harness.${module}`],
                { cwd: HERMES_DIR, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
                (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })),
              )
            })
            const out = [stdout, stderr].filter(Boolean).join('\n---stderr---\n').slice(0, 4000)
            return ok(`Eseguito senza errori.${out ? `\n\n${out}` : ' (nessun output)'}`)
          } catch (err) {
            const out = [err.stdout, err.stderr].filter(Boolean).join('\n---stderr---\n').slice(0, 4000)
            const why = err.killed ? `interrotto dopo ${timeoutMs / 1000}s (timeout)` : `uscito con errore (${err.code ?? 'sconosciuto'})`
            return refuse(`Esecuzione fallita: ${why}.${out ? `\n\n${out}` : ''}`)
          }
        },
      ),

      tool(
        'add_cron_job',
        "Schedula per davvero una nuova automazione, da eseguire ricorrentemente senza supervisione. Chiamalo " +
          "SOLO dopo che: (a) l'utente ha confermato esplicitamente il piano in conversazione, e (b) hai " +
          "verificato lo script con run_script_now senza errori. Il comando eseguito è costruito automaticamente " +
          "da questo strumento (sempre 'cd hermes-agent && uv run python -m harness.<module>') — non puoi " +
          "passare un comando arbitrario, solo il nome del modulo.",
        {
          module: z.string().describe("Nome del modulo già scritto e testato, es. 'usa_iran_watch'."),
          schedule: z
            .string()
            .describe("Schedule cron a 5 campi (minuto ora giorno-mese mese giorno-settimana), es. '0 */2 * * *' per ogni 2 ore."),
          description: z.string().describe("Descrizione breve in italiano di cosa fa — comparirà nella card AUTOMAZIONI della home."),
        },
        async (args) => {
          const { module, error: nameError } = checkModuleName(args.module)
          if (nameError) return refuse(nameError)
          if (!scriptExists(module)) {
            return refuse(`Non trovato: harness/${module}.py non esiste. Scrivilo e testalo con run_script_now prima di schedularlo.`)
          }
          const schedule = String(args.schedule ?? '').trim()
          if (!isValidSchedule(schedule)) {
            return refuse(`Schedule non valido: "${args.schedule}". Serve il formato cron a 5 campi, es. "0 */2 * * *" o "30 9 * * *".`)
          }
          const description = String(args.description ?? '').trim()
          if (!description) return refuse('Serve una descrizione breve di cosa fa questa automazione.')

          const { text, job: existing } = await findJob(module)
          if (existing) {
            return refuse(`"${module}" è già schedulato (${existing.schedule}). Usa update_cron_job per modificarlo.`)
          }
          const trimmed = text.replace(/\s*$/, '')
          const newText = `${trimmed}${trimmed ? '\n' : ''}# jarvis: ${description}\n${schedule} ${commandFor(module)}\n`
          try {
            await writeCrontabText(newText)
          } catch (err) {
            return refuse(`Scrittura del crontab fallita: ${err.message}. Il crontab precedente è intatto.`)
          }
          return ok(`Automazione "${module}" attivata: ${description} — ${schedule}.`)
        },
      ),

      tool(
        'update_cron_job',
        "Modifica un'automazione già schedulata: il suo orario, la sua descrizione, o la attiva/disattiva " +
          "(senza cancellarla). Identificala per nome del modulo — usa list_cron_jobs se non lo ricordi.",
        {
          module: z.string().describe("Nome del modulo dell'automazione da modificare."),
          schedule: z.string().optional().describe("Nuovo schedule cron a 5 campi, se va cambiato l'orario."),
          description: z.string().optional().describe("Nuova descrizione, se va cambiata."),
          enabled: z.boolean().optional().describe("false = disattiva (resta configurata ma non gira più), true = riattiva."),
        },
        async (args) => {
          const { module, error: nameError } = checkModuleName(args.module)
          if (nameError) return refuse(nameError)
          const { lines, job } = await findJob(module)
          if (!job) return refuse(`Nessuna automazione per il modulo "${module}". Usa list_cron_jobs per vedere quelle esistenti.`)

          const schedule = args.schedule !== undefined ? String(args.schedule).trim() : job.schedule
          if (args.schedule !== undefined && !isValidSchedule(schedule)) {
            return refuse(`Schedule non valido: "${args.schedule}".`)
          }
          const description = args.description !== undefined ? String(args.description).trim() : job.description
          const enabled = args.enabled !== undefined ? !!args.enabled : job.enabled
          if (args.schedule === undefined && args.description === undefined && args.enabled === undefined) {
            return refuse('Non modificata: specifica cosa cambiare (orario, descrizione, o attiva/disattiva).')
          }

          const newLines = [...lines]
          const commandLine = `${enabled ? '' : '# '}${schedule} ${commandFor(module)}`
          newLines[job.commandLine] = commandLine
          if (job.commentLine >= 0) {
            newLines[job.commentLine] = description ? `# jarvis: ${description}` : null
          } else if (description) {
            newLines.splice(job.commandLine, 0, `# jarvis: ${description}`)
          }
          try {
            await writeCrontabText(newLines.filter((l) => l !== null).join('\n'))
          } catch (err) {
            return refuse(`Scrittura del crontab fallita: ${err.message}. Il crontab precedente è intatto.`)
          }

          const bits = []
          if (args.schedule !== undefined) bits.push(`orario ${schedule}`)
          if (args.description !== undefined) bits.push('descrizione aggiornata')
          if (args.enabled !== undefined) bits.push(enabled ? 'riattivata' : 'disattivata')
          return ok(`Automazione "${module}" aggiornata: ${bits.join(', ')}.`)
        },
      ),

      tool(
        'remove_cron_job',
        "Rimuove definitivamente un'automazione schedulata. Se l'utente potrebbe volerla solo mettere in pausa, " +
          "usa update_cron_job con enabled:false invece — è reversibile, questo no.",
        {
          module: z.string().describe("Nome del modulo dell'automazione da rimuovere."),
        },
        async (args) => {
          const { module, error: nameError } = checkModuleName(args.module)
          if (nameError) return refuse(nameError)
          const { lines, job } = await findJob(module)
          if (!job) return refuse(`Nessuna automazione per il modulo "${module}". Usa list_cron_jobs per vedere quelle esistenti.`)

          const newLines = lines.filter((_, i) => i !== job.commandLine && i !== job.commentLine)
          try {
            await writeCrontabText(newLines.join('\n'))
          } catch (err) {
            return refuse(`Scrittura del crontab fallita: ${err.message}. Il crontab precedente è intatto.`)
          }
          return ok(`Automazione "${module}" rimossa dal crontab.`)
        },
      ),
    ],
  })
}
