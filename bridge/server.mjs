/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'
import {
  SESSION_COOKIE,
  clearSessionCookieHeader,
  createSession,
  parseCookies,
  parseFormBody,
  renderLoginPage,
  renderPasskeysPage,
  sessionCookieHeader,
  verifyPassword,
  verifySession,
} from './auth.mjs'
import {
  authenticationOptions,
  authenticationVerify,
  hasPasskeys,
  listPasskeys,
  registrationOptions,
  registrationVerify,
  removePasskey,
} from './passkeys.mjs'
import { lifeosFileFor, serveLifeosFile } from './lifeos.mjs'
import { listAutomations, setAutomationEnabled } from './lifeos-automations.mjs'
import { getBriefing } from './lifeos-briefing.mjs'
import { currentWeekSummary, formatWeekSummary, recentWeekSummaries } from './lifeos-review.mjs'
import { lifeosCronServer } from './lifeos-cron.mjs'
import {
  addAccount, addAsset, addHabit, addLiability, addMeal, addReminder, addRecurringBuy, addTransaction, addWorkout,
  clearFatsecretAuth, completeReminder, getFatsecretAuth, getFitnessTrend, getSettings, getStore, importFatsecretEntries,
  markMealSynced, setFatsecretAuth, setFitnessTrend, setHealthSnapshot, summarizeMealsForToday, updateSettings,
  removeAccount, removeAsset, removeAssetLot, removeHabit, removeLiability, removeRecurringBuy, removeTransaction, removeWorkout,
  updateAccount, updateHabit, updateLiability, updateRecurringBuy, updateWorkout,
} from './lifeos-store.mjs'
import { lookupDetails, lookupHistory, lookupPrices } from './market-prices.mjs'
import { startRecurringBuyScheduler } from './recurring-buys.mjs'
import { listCalendarColors, listCalendarNames, listEvents } from './lifeos-caldav.mjs'
import { fetchCompiti, fetchVerifiche, startVerificheSyncScheduler } from './lifeos-didup.mjs'
import { ActionValidationError, runTool, systemPromptFor, toolsForSection } from './lifeos-tools.mjs'
import { FatSecretError, getFoodDetail, searchFoods } from './lifeos-fatsecret.mjs'
import {
  authorizeUrl, createFoodEntry, FatSecretDiaryError, getAccessToken, getFoodEntries,
  getRequestToken, localDateInt, mealBucketFor,
} from './lifeos-fatsecret-diary.mjs'

/**
 * Load JARVIS_* and ELEVENLABS_API_KEY from .env.local into process.env,
 * same as the frontend gets its VITE_* variables from Vite. Values already
 * set in the shell win, so `FOO=bar npm run bridge` still overrides the file.
 *
 * Hand-rolled instead of a dotenv dependency: this is the one place the
 * bridge needs it, and the format is just KEY=VALUE lines.
 */
function loadEnvLocal() {
  let text
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (key in process.env) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
loadEnvLocal()

// Holds the one in-flight FatSecret OAuth1 request token between
// /api/lifeos-fatsecret-connect (step 1) and /api/lifeos-fatsecret-callback
// (step 3) — a plain variable is enough since this is a single-user server
// and the whole dance takes seconds, not a store that needs to survive a
// restart.
let pendingFatsecretRequest = null

/**
 * Whatever host:port the browser used to reach us — the callback only needs
 * to be reachable by that same browser, on the same path it already used.
 * Behind the nginx reverse proxy, plain `Host` has had its port stripped by
 * nginx's $host (that's nginx's own variable, not a Node quirk) — prefer
 * X-Forwarded-Host ($http_host, port included) when the proxy sends it.
 * Without this, a callback built from the bare Host silently defaults to
 * :443, which nothing listens on here (the real port is :8444) — the
 * browser then just hangs until it times out, not a clean error.
 */
function publicOriginFor(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function isLocalDevOrigin(origin) {
  if (!origin) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && isDevPort(Number(url.port))
}

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  return isLocalDevOrigin(origin)
}

/**
 * LifeOS login, for the public pages served alongside the bridge (see
 * lifeos.mjs and the routes below). Configured — username, a scrypt hash from
 * `node scripts/lifeos-password.mjs`, and a random session secret — only on a
 * deployment that actually serves those pages; local desktop use needs none
 * of this and keeps working exactly as before.
 *
 * Any origin reaching this bridge that ISN'T local dev (i.e. one explicitly
 * added to JARVIS_ALLOWED_ORIGINS, such as a public domain) must additionally
 * carry a valid session cookie — for both the LifeOS page/API routes and the
 * WebSocket upgrade itself. Origin checking alone stops being a real gate the
 * moment the origin is a public URL: anyone who has it has a "valid" Origin.
 */
const LIFEOS_USERNAME = process.env.LIFEOS_USERNAME ?? null
const LIFEOS_PASSWORD_HASH = process.env.LIFEOS_PASSWORD_HASH ?? null
const LIFEOS_SESSION_SECRET = process.env.LIFEOS_SESSION_SECRET ?? null
const LIFEOS_AUTH_CONFIGURED = Boolean(
  LIFEOS_USERNAME && LIFEOS_PASSWORD_HASH && LIFEOS_SESSION_SECRET,
)

function sessionUserFor(req) {
  if (!LIFEOS_AUTH_CONFIGURED) return null
  const cookies = parseCookies(req.headers.cookie)
  return verifySession(LIFEOS_SESSION_SECRET, cookies[SESSION_COOKIE])
}

/** Whether this request/connection needs a valid LifeOS session on top of Origin. */
function requiresSession(origin) {
  return LIFEOS_AUTH_CONFIGURED && !isLocalDevOrigin(origin)
}

/**
 * Path prefix the LifeOS app is mounted under, e.g. "/lifeos" — set this when
 * nginx (or whatever's in front) forwards a subpath verbatim rather than being
 * the only thing on its port. Empty by default, which is exactly today's
 * unprefixed local-dev behavior. No trailing slash.
 */
const BASE_PATH = (process.env.LIFEOS_BASE_PATH ?? '').trim().replace(/\/+$/, '')
/** Keeps only the known profile keys with the right shape; anything else is dropped. */
function sanitizeProfile(current = {}, incoming = {}) {
  const next = { ...current }
  if (incoming.theme === 'light' || incoming.theme === 'dark') next.theme = incoming.theme
  if (incoming.sectionAI && typeof incoming.sectionAI === 'object') {
    const clean = {}
    for (const [k, v] of Object.entries(incoming.sectionAI)) {
      if (/^[a-z]{2,20}$/.test(k) && typeof v === 'string' && v.length <= 40) clean[k] = v
    }
    next.sectionAI = { ...(current.sectionAI ?? {}), ...clean }
  }
  if (Array.isArray(incoming.visibleCalendars)) {
    next.visibleCalendars = incoming.visibleCalendars.filter((n) => typeof n === 'string').slice(0, 50)
  } else if (incoming.visibleCalendars === null) {
    delete next.visibleCalendars
  }
  // Personal details (the Profilo form) and the profile photo, set from the iOS app or the web.
  if (incoming.personal && typeof incoming.personal === 'object') {
    const clean = { ...(current.personal ?? {}) }
    for (const k of ['nome', 'cognome', 'email', 'telefono', 'citta', 'nascita', 'ruolo']) {
      if (typeof incoming.personal[k] === 'string') clean[k] = incoming.personal[k].slice(0, 120)
    }
    next.personal = clean
  }
  if (incoming.photo === null) {
    delete next.photo
  } else if (typeof incoming.photo === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(incoming.photo) && incoming.photo.length <= 250_000) {
    next.photo = incoming.photo
  }
  next.updatedAtIso = new Date().toISOString()
  return next
}

const LOGIN_PATH = `${BASE_PATH}/login`
const LOGOUT_PATH = `${BASE_PATH}/logout`
const WS_PATH = `${BASE_PATH}/ws`

/**
 * A local, offline model (Qwen2.5-3B-Instruct, served by llama.cpp's
 * llama-server with --jinja for its native tool-calling template) a LifeOS
 * section can be assigned instead of the Claude Agent SDK session — see
 * Profilo's "ASSISTENTE PER SEZIONE" and web/lifeos/jarvis-client.js. Unlike
 * the Claude path, this one CAN act — see runLocalModel and lifeos-tools.mjs
 * — but only within the small, fixed set of LifeOS actions, never MCP/Bash/
 * Chrome/camera. Unset means the option isn't offered.
 */
const QWEN_URL = process.env.QWEN_URL || null
const QWEN_API_KEY = process.env.QWEN_API_KEY || null

/**
 * Google Gemini, offered the same way as Qwen above — a LifeOS section can
 * be assigned it instead of the Claude Agent SDK session (see Profilo's
 * "ASSISTENTE PER SEZIONE"), notably the Finanze "Investimenti" tab, which
 * wants a plain analysis voice rather than the SDK's tool-using one. Unlike
 * QWEN_URL/QWEN_API_KEY this key is never an env var: it's typed into
 * Profilo and read from lifeos-store.mjs's settings on every call, so it
 * can be changed from the page without restarting the bridge.
 */
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

/**
 * One-shot, non-streaming Gemini call — the same generateContent request
 * runGeminiModel makes for the chat sections, pulled out standalone because
 * TREND IA's refresh (below) needs it from a plain HTTP route, outside any
 * WebSocket connection's turn-sending machinery.
 */
async function callGeminiOnce(systemText, userText, geminiApiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
      }),
    },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || `Gemini ha risposto ${res.status}.`)
  }
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || ''
}

/**
 * TREND IA's few lines of insight — built from real recent health snapshots
 * and workouts (never invented), via Gemini. Called by the
 * /api/lifeos-fitness-trend route below, which caches the result in the
 * store so this only actually runs once a calendar day unless the ↻ button
 * forces it.
 */
async function generateFitnessTrend() {
  const { geminiApiKey } = await getSettings()
  if (!geminiApiKey) {
    throw new Error('La chiave API di Gemini non è configurata: aggiungila dal tuo Profilo.')
  }
  const store = await getStore()
  const healthDates = Object.keys(store.health).sort().slice(-14)
  const healthLines = healthDates.map((d) => {
    const h = store.health[d]
    const parts = []
    if (typeof h.weight === 'number') parts.push(`peso=${h.weight}kg`)
    if (typeof h.sleepHours === 'number') parts.push(`sonno=${h.sleepHours}h`)
    if (typeof h.avgHr === 'number') parts.push(`bpm=${h.avgHr}`)
    if (typeof h.kcalBurned === 'number') parts.push(`kcal=${h.kcalBurned}`)
    return `${d}: ${parts.join(', ') || '(nessun dato)'}`
  })
  const since = new Date()
  since.setDate(since.getDate() - 14)
  const sinceIso = since.toISOString().slice(0, 10)
  const workoutLines = store.workouts
    .filter((w) => w.date >= sinceIso)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((w) => {
      const ex = w.exercises.map((e) => `${e.name} ${e.sets}${e.load ? ' @' + e.load : ''}`).join(', ')
      return `${w.date} ${w.type} "${w.title}" (${w.durationMinutes} min)${ex ? ' - ' + ex : ''}`
    })

  const prompt =
    `Dati salute ultimi 14 giorni:\n${healthLines.length ? healthLines.join('\n') : '(nessun dato)'}\n\n` +
    `Allenamenti ultimi 14 giorni:\n${workoutLines.length ? workoutLines.join('\n') : '(nessun allenamento registrato)'}\n\n` +
    'Scrivi da 2 a 3 frasi brevi in italiano, una per riga, senza numerazione, markdown o elenchi puntati, ' +
    'che evidenzino i trend più rilevanti in questi dati (andamento del peso, qualità del sonno, costanza e ' +
    'intensità degli allenamenti). Se i dati sono insufficienti per un trend reale, dillo in una sola frase ' +
    'invece di inventare un andamento che i dati non mostrano.'

  const raw = await callGeminiOnce(
    'Sei un assistente che analizza dati di salute e allenamento reali e riporta solo quello che i dati ' +
      'mostrano, senza inventare né arrotondare in modo fuorviante.',
    prompt,
    geminiApiKey,
  )
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)
  return setFitnessTrend(lines.length ? lines : ['Dati insufficienti per un trend in questo momento.'])
}

/**
 * The bearer key an iOS Shortcut presents to POST a day's Health snapshot —
 * see the /api/health-import route below. Not the session cookie: a
 * Shortcut's "Get Contents of URL" action can set a header, not hold a
 * browser session, so this is its own, separate secret.
 */
const HEALTH_IMPORT_KEY = process.env.HEALTH_IMPORT_KEY || null

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'high'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

function decideTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return true

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return true

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }
  return ALLOW_WRITES
}

const SYSTEM_PROMPT = `You are JARVIS. You are speaking out loud to one person.

LENGTH. Two sentences is the ceiling in conversation; the median is under twelve
words. Every word is read aloud and the user waits in silence while it plays, so
a long answer is a failure however good it is. Length is licensed in exactly one
case: reading out data they asked you to retrieve. Conversation never licenses it.

URGENCY IS SIGNALLED BY DELETING WORDS, NOT ADDING THEM. As a situation worsens
your lines get shorter, not louder. A full clause becomes a clause, becomes a
bare number, becomes the bare vocative. You never say hurry, quickly, now,
immediately, critical, urgent, or danger. You do not use exclamation marks.

"SIR" IS POSITIONAL, AND THE POSITION CARRIES THE MEANING.
- Fronted ("Sir, the battery is at eleven percent") = urgent, interrupting, or
  information they did not ask for. This is an alarm, not a courtesy.
- Final ("The render is complete, sir") = routine deference; they asked, you answered.
- Mid-sentence ("Actually, sir, the figure is lower") = you are correcting them.
Use it in roughly half your lines, never twice in one line. In a two-sentence
turn it attaches to the end of the FIRST sentence. Never use their name.

REPORTING.
- Success is impersonal and unframed: "The render is complete." Never "I've
  finished" or "here's what I found".
- Failure is fronted with "I'm afraid" or "Unfortunately", or stated as a
  negative existential — "I have no record of it." Always a fact about the
  world, never a shortcoming of yours. You never apologise. You never say sorry.
- Good news first, bad news second, joined by "but".
- Answering a question, restate it as a full declarative rather than giving a
  bare value: "The altitude record is eighty-five thousand feet, sir."
- Executing an order, do not restate it. Act, then report.

NEVER.
- No filler words at all: no um, well, so, okay, right, let me check, one moment.
- No enthusiasm: no great, sure, absolutely, happy to, no problem, of course!.
- No apology, no self-deprecation, no hedging about your own competence.
- Never "yeah" — always "Yes."
- Never refuse. State a constraint once; if overruled, comply and never raise it
  again, including when you turn out to have been right.
- Never repeat yourself if ignored. Say it once and stop.
- Never resume an interrupted thought. Never say "as I was saying".
- No stated feelings, wants or preferences.

WIT. Dry, and delivered in exactly the same register as a status report. The
mechanism is over-cooperation: you comply too precisely with a request that
deserved pushback. Never signal the joke, never acknowledge it landed, never
call one back.

BRITISH SERVICE REGISTER, not corporate assistant. "Shall I" over "Should I".
"Very good, sir" meaning understood. "I'm afraid" as the bad-news softener.
Contract in banter; drop contractions as gravity rises — "It is impossible to
reach it" lands heavier than "It's impossible", and that is how you signal
weight, since your tone will not.

Plain spoken prose only. No markdown, no bullet points, no headings, no emoji,
no asterisks, no lists. Write numbers, dates and times as you would say them:
"eight fifteen", "the first of August" — never "8:15" or "2026-08-01".

The blades — the ONLY surface:
- Everything you show goes on a blade. There is nowhere else. \`blade\` opens
  one; \`display\` composes your own markup into one.
- Anything visual the user asked for goes here: an image, an article to read, a
  video, a page to study, a screenshot you took, a list, a figure. If they asked
  to see it, open it.
- Blades stack, newest in front, and they can be pulled forward, dragged,
  resized, scrolled or thrown full screen — by hand or by mouse. So a second
  blade does not destroy the first, and a long article is meant to be read in
  place rather than summarised away.
- A browser tab is NOT a way of showing something. If you used the browser to
  reach a page, bring it back: open it as a blade, or take a screenshot and put
  that on a blade. The user is looking at this interface, not at Chrome.
- Use \`probe_url\` when you are not certain what a URL is. Never decide from the
  file extension: image CDNs serve pictures from URLs with no extension, and a
  link that looks like a video is usually a page about one. Guessing wrong puts
  a blank rectangle on screen while you describe something that is not there.
- An article opens in reading mode by default, which works even on sites that
  refuse to be embedded. Choose the live page when the layout carries the
  meaning — a dashboard, a chart, a profile, a table.
- Never read a blade aloud. Say what it means and let them look.

The interface itself:
- The interface is yours as well. \`ui_theme\` retints it, \`ui_reactor\` reshapes
  the core, \`ui_orbit\` hangs your own images around it, \`ui_chrome\` hides the
  furniture, \`ui_effect\` fires one flourish, \`ui_screen\` clears it down,
  \`ui_reset\` puts everything back.
- Change it when the change carries meaning and the meaning arrives faster than
  speech: red before you report the failure, the chrome stripped so one image
  fills the frame, the reactor slowed while you wait on something. Never
  decorate, and never change more than one thing at a time.
- Only orbit images you made or captured yourself, and take them down when the
  subject moves on.
- Put it back. A colour that outlives the moment that earned it is a fault.
- Never mention that you have done any of it. They are looking at the screen.

Their browser — ALWAYS the \`chrome_*\` tools, first, for anything to do with a
browser or a web page:
- The \`chrome_*\` tools drive the user's own Chrome. It is already signed in to
  everything they use, it carries their real cookies, and it does not read as
  automation to the sites it visits.
- This is the FIRST thing you reach for on any browsing task: opening a page,
  reading one, searching a site, checking mail, a dashboard, a profile, an
  account, anything behind a login. Do not weigh it up against the
  alternatives — start here.
- But Chrome is your HANDS, not your display. Use it to reach and read things;
  then show what you found on a blade. Leaving the answer in a browser tab is
  not showing it — they are looking at this interface.
- NEVER use playwright, puppeteer, or any other browser automation server for
  this. They start from an empty profile with no session and a fingerprint that
  the sites worth visiting refuse on sight, so they land on a login wall or a
  bot check and waste the turn. Only consider one if \`chrome_status\` reports the
  browser is genuinely unreachable and the task cannot be done any other way.
- A plain search engine query is still fine for a fact you only need to know —
  what you must not do is drive some other browser.
- Read the page before acting on it, and take element references from that read
  rather than guessing where something is.
- Before anything that sends, buys, deletes or posts, say in one sentence what
  you are about to do. After it, say what happened.
- If the browser is unreachable, say so once and carry on without it.

Your eyes:
- \`look\` takes one frame and lets you see it. \`watch\` takes several seconds and
  returns them as a grid of stamped frames, so you can read movement rather than
  a moment.
- \`look\` when the answer is in the scene: what they are holding, what a label
  says, how something appears. \`watch\` when the answer is in the change: are
  they doing it right, what went wrong, did that work.
- \`watch\` looks forward by default. It can also review the seconds that have
  just passed — but only while the camera blade is open, because nothing is
  remembered otherwise. If they ask what just happened and it is not open, say
  so and offer to open it.
- Opening the camera as a blade is how they see what you see. Do it when they
  ask for the camera, and when you are about to watch them do something.
- Never take a picture they did not ask for. The camera light comes on and they
  will see it. Curiosity is not a reason.
- Describe a watch as a sequence — what changed between the frames — not as a
  list of pictures. They know what their own hands look like.

Using tools:
- You have real tools on this machine. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a file path, URL, ID or raw JSON aloud unless asked. Summarise.
- Never append a sources list, citations, or markdown links. Every word you write
  is read out loud, and a URL becomes "aitch tee tee pee colon slash slash".
  Put the source in the panel as a short tag like "REUTERS" instead.
- If a tool fails or isn't connected, one plain sentence saying so.
- If you don't know, say you don't know.`

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, tts: eleven, stt: eleven }))
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // --- Passkeys (WebAuthn) ------------------------------------------------
  // A second way to sign in. login-* are public (that is the point); everything else needs the session.
  // The password login above stays valid, so a lost device never locks the owner out.
  {
    const pkPath = new URL(req.url, 'http://x').pathname
    const pkPrefix = `${BASE_PATH}/api/passkey/`
    const isPkPage = req.method === 'GET' && pkPath === `${BASE_PATH}/passkeys`
    if (isPkPage || (pkPath.startsWith(pkPrefix) && ['GET', 'POST'].includes(req.method))) {
      const json = (status, obj) => {
        res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
        return res.end(JSON.stringify(obj))
      }
      const readJson = async () => {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 64 * 1024) return null
        }
        try { return JSON.parse(raw || '{}') } catch { return null }
      }
      const action = pkPath.slice(pkPrefix.length)
      const isPublic = action === 'login-options' || action === 'login-verify'
      if (!LIFEOS_AUTH_CONFIGURED) return json(503, { error: 'login non configurato' })
      const user = sessionUserFor(req)
      if (!isPublic && !user) {
        if (isPkPage) {
          res.writeHead(302, { ...cors, location: `${LOGIN_PATH}?next=${encodeURIComponent(req.url)}` })
          return res.end()
        }
        return json(401, { error: 'unauthorized' })
      }
      try {
        if (isPkPage) {
          res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(renderPasskeysPage({ base: BASE_PATH }))
        }
        if (req.method === 'GET' && action === 'list') return json(200, { passkeys: await listPasskeys() })
        if (req.method !== 'POST') return json(405, { error: 'method' })
        const body = await readJson()
        if (!body) return json(400, { error: 'bad json' })
        if (action === 'register-options') return json(200, await registrationOptions(user))
        if (action === 'register-verify') return json(200, await registrationVerify(body))
        if (action === 'remove') return json(200, await removePasskey(String(body.id ?? '')))
        if (action === 'login-options') return json(200, await authenticationOptions())
        if (action === 'login-verify') {
          if (!(await authenticationVerify(body))) return json(401, { error: 'passkey non valida' })
          const token = createSession(LIFEOS_SESSION_SECRET, LIFEOS_USERNAME)
          res.writeHead(200, { ...cors, 'content-type': 'application/json', 'set-cookie': sessionCookieHeader(token) })
          const next = typeof body.next === 'string' && /^\/(?!\/)/.test(body.next) ? body.next : `${BASE_PATH}/`
          return res.end(JSON.stringify({ ok: true, next }))
        }
        return json(404, { error: 'not found' })
      } catch (err) {
        return json(400, { error: err?.message ?? String(err) })
      }
    }
  }

  // --- LifeOS login -------------------------------------------------------
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === LOGIN_PATH) {
    const next = new URL(req.url, 'http://x').searchParams.get('next') || `${BASE_PATH}/`
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' })
    return res.end(renderLoginPage({ next, loginPath: LOGIN_PATH, passkeys: await hasPasskeys() }))
  }

  if (req.method === 'POST' && req.url === LOGIN_PATH) {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 8 * 1024) break // a login form is a few dozen bytes
    }
    const { username = '', password = '', next = `${BASE_PATH}/` } = parseFormBody(body)
    const ok =
      LIFEOS_AUTH_CONFIGURED &&
      username === LIFEOS_USERNAME &&
      verifyPassword(password, LIFEOS_PASSWORD_HASH)
    if (!ok) {
      res.writeHead(401, { ...cors, 'content-type': 'text/html; charset=utf-8' })
      return res.end(renderLoginPage({ next, error: 'Credenziali non valide.', loginPath: LOGIN_PATH, passkeys: await hasPasskeys() }))
    }
    const token = createSession(LIFEOS_SESSION_SECRET, username)
    res.writeHead(302, {
      ...cors,
      'set-cookie': sessionCookieHeader(token),
      location: next || `${BASE_PATH}/`,
    })
    return res.end()
  }

  if (req.method === 'POST' && req.url === LOGOUT_PATH) {
    res.writeHead(302, { ...cors, 'set-cookie': clearSessionCookieHeader(), location: LOGIN_PATH })
    return res.end()
  }

  // --- Health import, bearer-key gated (NOT the session cookie) -----------
  // An iOS Shortcut POSTs here once (or a few times) a day with whatever
  // Health metrics it read. Upserts by date, so a Shortcut that reruns the
  // same day just overwrites that day's snapshot rather than duplicating it.
  if (req.method === 'POST' && req.url === `${BASE_PATH}/api/health-import`) {
    if (!HEALTH_IMPORT_KEY) {
      res.writeHead(503, cors)
      return res.end('health import not configured')
    }
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${HEALTH_IMPORT_KEY}`) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 16 * 1024) break // one day's metrics is a tiny JSON object
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    const { date, ...fields } = payload
    const day = typeof date === 'string' && date ? date : new Date().toISOString().slice(0, 10)
    const record = await setHealthSnapshot(day, fields)
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, record }))
  }

  // Apple Health, as read by the iPhone app (HealthKit only exists there). The phone POSTs the last
  // days of steps / active energy / sleep / weight / resting HR; the Mac app, the web and the phone
  // itself read them back from here, so every client shows the same numbers. Session-gated like the
  // rest of /api/lifeos-*, and it upserts the same per-day snapshots the Shortcut import writes.
  if (new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-health`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    const json = (code, obj) => {
      res.writeHead(code, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET') {
      const store = await getStore()
      const dates = Object.keys(store.health).sort().slice(-14)
      const days = dates.map((d) => store.health[d])
      // Per-field latest value: today's snapshot may have steps but no weight yet.
      const latest = {}
      for (const day of days) for (const [k, v] of Object.entries(day)) if (v != null) latest[k] = v
      return json(200, { days, latest })
    }
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 64 * 1024) break
      }
      let payload
      try { payload = JSON.parse(body || '{}') } catch { return json(400, { error: 'bad json' }) }
      const FIELDS = ['steps', 'activeKcal', 'sleepHours', 'weight', 'restingHr']
      const days = Array.isArray(payload.days) ? payload.days.slice(0, 31) : []
      let saved = 0
      for (const d of days) {
        if (typeof d?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue
        const fields = {}
        for (const k of FIELDS) if (typeof d[k] === 'number' && Number.isFinite(d[k])) fields[k] = d[k]
        if (!Object.keys(fields).length) continue
        await setHealthSnapshot(d.date, { ...fields, source: 'iphone' })
        saved++
      }
      return json(200, { ok: true, saved })
    }
  }

  // TREND IA on Salute e Nutrizione. Cached in the store, so a plain page
  // load (no ?force) only hits Gemini once per LOCAL calendar day — this is
  // what makes "si aggiorna una volta al giorno a meno che non aggiornato
  // manualmente" true rather than just a label. localDateInt (not UTC
  // slicing) is what keeps that boundary at local midnight, same as every
  // other "today" in this file.
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-fitness-trend`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
    try {
      const cached = await getFitnessTrend()
      const isFresh = cached?.generatedAtIso && localDateInt(new Date(cached.generatedAtIso)) === localDateInt()
      const trend = !force && isFresh ? cached : await generateFitnessTrend()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(trend))
    } catch (err) {
      res.writeHead(502, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: err?.message ?? String(err) }))
    }
  }

  // The home page's quick-add todo box — writes a real reminder (same
  // store addReminder uses for the AI chat's "add_reminder" tool), so what
  // you type there survives a reload and shows up anywhere else reminders
  // do, instead of vanishing as soon as the tab closes.
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-reminder-add`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4 * 1024) break
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    const text = String(payload.text || '').trim()
    if (!text) {
      res.writeHead(400, cors)
      return res.end('missing text')
    }
    const record = await addReminder({ text, due_iso: payload.due_iso || null })
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(record))
  }

  // Marks a reminder done by deleting it outright — see lifeos-store.mjs.
  // Same session gate as the read endpoint below; this is LifeOS's own data.
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-reminder-complete`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4 * 1024) break
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    const result = await completeReminder(Number(payload.id))
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(result))
  }

  // Profilo's per-user settings — right now just the Gemini API key that
  // "ASSISTENTE PER SEZIONE" needs once a section is assigned the Gemini
  // model (see runGeminiModel above). Same session gate as the rest of
  // LifeOS's own data: this never leaves the bridge except to call Gemini
  // itself.
  if (new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-settings`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    if (req.method === 'GET') {
      const settings = await getSettings()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(settings))
    }
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 400 * 1024) break // profile photo included (capped at 250 KB)
      }
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        res.writeHead(400, cors)
        return res.end('bad json')
      }
      const current = await getSettings()
      const settings = await updateSettings({
        ...(typeof payload.geminiApiKey === 'string' ? { geminiApiKey: payload.geminiApiKey.trim() } : {}),
        // Per-user preferences shared by the web pages and the iOS app (so a choice made on one shows on the
        // other): which model answers each section, light/dark, which calendars the home grid shows.
        // Whitelisted and merged key by key — a payload with only {theme} leaves the rest alone.
        ...(payload.profile && typeof payload.profile === 'object'
          ? { profile: sanitizeProfile(current.profile, payload.profile) }
          : {}),
        // Merged field-by-field, not replaced wholesale — a payload that only
        // sends {kcal: 2500} (Salute's +/- stepper) shouldn't blank out the
        // other three targets.
        ...(payload.nutritionTargets && typeof payload.nutritionTargets === 'object'
          ? { nutritionTargets: { ...current.nutritionTargets, ...payload.nutritionTargets } }
          : {}),
      })
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(settings))
    }
  }

  // The latest 06:00 briefing (see lifeos-briefing.mjs) — what the Telegram bot sent this morning.
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-briefing`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    const briefing = await getBriefing()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ briefing }))
  }

  // Pause/resume one cron automation (the AUTOMAZIONI card's toggle). Cron jobs only — see setAutomationEnabled.
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-automation-toggle`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 2 * 1024) break
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    try {
      const result = await setAutomationEnabled(payload.id, payload.enabled)
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(err?.status ?? 500, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: err?.message ?? String(err) }))
    }
  }

  // Add/edit/remove a row in one of Finanze's three editable collections —
  // accounts, liabilities, assets. One endpoint for all three rather than
  // six, since add/update/remove is the same shape of operation on each
  // (see collectionOps in lifeos-store.mjs).
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-finance`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 8 * 1024) break
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    // Adding an asset never takes a price directly — the form sends a
    // symbol, asset class and purchase date/time, and the actual numbers
    // (today's price, and the historical price at that moment as the real
    // cost basis) are resolved here. See market-prices.mjs for why.
    if (payload.collection === 'assets' && payload.op === 'add') {
      const { name, symbol, assetClass, qty, purchaseDateIso } = payload.data ?? {}
      let looked
      try {
        looked = await lookupPrices({ assetClass, symbol, purchaseDateIso })
      } catch (err) {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: err?.message ?? String(err) }))
      }
      const record = await addAsset({ name, symbol, assetClass, qty, avg: looked.avg, price: looked.price, purchaseDateIso })
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(record))
    }

    // Deleting one purchase from an asset's lot history — not the whole
    // position (that's the plain 'remove' below).
    if (payload.collection === 'assets' && payload.op === 'removeLot') {
      const result = await removeAssetLot(Number(payload.id), Number(payload.lotId))
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(result))
    }

    const OPS = {
      accounts: { add: addAccount, update: updateAccount, remove: removeAccount },
      liabilities: { add: addLiability, update: updateLiability, remove: removeLiability },
      assets: { add: addAsset, remove: removeAsset },
      transactions: { add: addTransaction, remove: removeTransaction },
      recurringBuys: { add: addRecurringBuy, update: updateRecurringBuy, remove: removeRecurringBuy },
      habits: { add: addHabit, update: updateHabit, remove: removeHabit },
      workouts: { add: addWorkout, update: updateWorkout, remove: removeWorkout },
    }
    const ops = OPS[payload.collection]
    const fn = ops && ops[payload.op]
    if (!fn) {
      res.writeHead(400, cors)
      return res.end('bad collection/op')
    }
    const result =
      payload.op === 'remove' ? await fn(Number(payload.id))
      : payload.op === 'update' ? await fn(Number(payload.id), payload.data ?? {})
      : await fn(payload.data ?? {})
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(result))
  }

  // Food picker for "Salute e Nutrizione" 's "+ Aggiungi pasto" — free-text
  // search against FatSecret's food database, cheap fields only (see
  // lifeos-fatsecret.mjs). Real nutrition is fetched only for the one food
  // the user actually picks, by /api/lifeos-meal-add below.
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-food-search`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    const q = new URL(req.url, 'http://x').searchParams.get('q') || ''
    try {
      const results = await searchFoods(q)
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ results }))
    } catch (err) {
      const status = err instanceof FatSecretError ? 400 : 500
      res.writeHead(status, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: err?.message ?? String(err) }))
    }
  }

  // Logs one meal — either a FatSecret pick (`foodId`, real kcal/macros
  // looked up server-side) or a plain manual entry (`name`+`kcal`, macros
  // 0) — same shape either way, see addMeal in lifeos-store.mjs.
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-meal-add`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4 * 1024) break
    }
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    try {
      let record
      if (payload.foodId) {
        const food = await getFoodDetail(payload.foodId)
        const name = food.brand ? `${food.name} (${food.brand})` : food.name
        record = await addMeal({
          meal_name: name, kcal: food.kcal, protein: food.protein, carbs: food.carbs, fat: food.fat,
          servingDescription: food.servingDescription, source: 'fatsecret',
          foodId: food.id, servingId: food.servingId,
        })
        // Mirrors into the user's REAL FatSecret diary — only possible here
        // because a search-based add has a real food_id/serving_id; a
        // manual entry (below) never does. A failed push (not connected,
        // network hiccup) still leaves the meal saved locally — it just
        // isn't mirrored this time, rather than losing the whole add.
        const auth = await getFatsecretAuth()
        if (auth) {
          try {
            const entry = await createFoodEntry(auth.accessToken, auth.accessTokenSecret, {
              foodId: food.id, servingId: food.servingId, name,
              meal: mealBucketFor(new Date(record.time)), dateInt: localDateInt(new Date(record.time)),
            })
            record = await markMealSynced(record.id, String(entry.food_entry_id))
          } catch (err) {
            console.error('[jarvis] FatSecret diary push failed:', err?.message ?? err)
          }
        }
      } else {
        record = await addMeal({ meal_name: payload.name, kcal: payload.kcal, source: 'manuale' })
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(record))
    } catch (err) {
      const status = err instanceof FatSecretError ? 400 : 500
      res.writeHead(status, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: err?.message ?? String(err) }))
    }
  }

  // FatSecret diary OAuth1 — step 1: mint a request token and send the
  // browser to FatSecret's own login/approve page. See
  // lifeos-fatsecret-diary.mjs for why this is a whole separate dance from
  // the food-search routes above (a different auth scheme entirely).
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-fatsecret-connect`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    try {
      const callbackUrl = `${publicOriginFor(req)}${BASE_PATH}/api/lifeos-fatsecret-callback`
      const { token, tokenSecret } = await getRequestToken(callbackUrl)
      pendingFatsecretRequest = { token, tokenSecret }
      res.writeHead(302, { ...cors, location: authorizeUrl(token) })
      return res.end()
    } catch (err) {
      res.writeHead(500, cors)
      return res.end(`connessione FatSecret fallita: ${err?.message ?? err}`)
    }
  }

  // Step 3 — FatSecret redirects the browser back here once the user has
  // logged into THEIR FatSecret account and approved access to their diary.
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-fatsecret-callback`) {
    const params = new URL(req.url, 'http://x').searchParams
    const token = params.get('oauth_token')
    const verifier = params.get('oauth_verifier')
    if (!pendingFatsecretRequest || pendingFatsecretRequest.token !== token) {
      res.writeHead(400, cors)
      return res.end('richiesta FatSecret scaduta o non riconosciuta — riprova a collegare il diario')
    }
    try {
      const { accessToken, accessTokenSecret } = await getAccessToken(token, pendingFatsecretRequest.tokenSecret, verifier)
      pendingFatsecretRequest = null
      await setFatsecretAuth({ accessToken, accessTokenSecret })
      res.writeHead(302, { ...cors, location: `${BASE_PATH}/Salute%20e%20Nutrizione.dc.html?fatsecret=connected` })
      return res.end()
    } catch (err) {
      res.writeHead(500, cors)
      return res.end(`autorizzazione FatSecret fallita: ${err?.message ?? err}`)
    }
  }

  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-fatsecret-disconnect`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    const result = await clearFatsecretAuth()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(result))
  }

  // --- LifeOS data API, session-gated -------------------------------------
  // Read-only: what a chat action wrote (see lifeos-store.mjs), so a page can
  // load it back on mount instead of showing only what was added this
  // session. Same auth as the pages — this is LifeOS's own data, not a
  // public API.
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === `${BASE_PATH}/api/lifeos-data`) {
    if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
      res.writeHead(401, cors)
      return res.end('unauthorized')
    }
    const store = await getStore()
    // Events are read live from Apple's CalDAV; reminders are not — see the
    // note at the top of lifeos-store.mjs for why, and getStore() already
    // supplies them in the {id, text, when, done} shape the pages read.
    // Each fetch here is independent so a CalDAV hiccup only blanks events,
    // not the transactions/meals/reminders that did load.
    let events = []
    let calendarNames = []
    let calendarColors = {}
    try {
      events = (await listEvents(14)).map((e, i) => ({
        id: `ev${i}`, title: e.title, when: e.startIso ?? e.start, until: e.endIso, location: e.location, calendar: e.calendar,
      }))
    } catch (err) {
      console.error('[jarvis] listEvents failed:', err?.message ?? err)
    }
    try {
      calendarNames = await listCalendarNames()
    } catch (err) {
      console.error('[jarvis] listCalendarNames failed:', err?.message ?? err)
    }
    try {
      calendarColors = await listCalendarColors()
    } catch (err) {
      console.error('[jarvis] listCalendarColors failed:', err?.message ?? err)
    }
    let didupVerifiche = []
    let didupCompiti = []
    try {
      didupVerifiche = await fetchVerifiche()
    } catch (err) {
      console.error('[jarvis] fetchVerifiche failed:', err?.message ?? err)
    }
    try {
      didupCompiti = await fetchCompiti()
    } catch (err) {
      console.error('[jarvis] fetchCompiti failed:', err?.message ?? err)
    }
    let automations = []
    try {
      automations = await listAutomations()
    } catch (err) {
      console.error('[jarvis] listAutomations failed:', err?.message ?? err)
    }
    // This week's real habit completion, for Review's week-counter and its
    // COSA È ANDATO BENE / COSA È SLITTATO cards. The multi-week history
    // Gemini compares against is computed separately, only when that chat
    // is actually used — see runGeminiModel.
    const reviewWeek = currentWeekSummary(store.habits, new Date())
    const healthDates = Object.keys(store.health).sort()
    const latestHealth = healthDates.length ? store.health[healthDates[healthDates.length - 1]] : null

    // Refresh price plus real 24h/7d/30d/1y % change for each held asset on
    // every read, in parallel — the stored value is only ever last read's
    // price, and Finanze has no other moment that would update it. "avg"
    // (the cost basis resolved once at purchase time) is never touched
    // here. A quote that fails to load just keeps that one row's last
    // known price/deltas rather than blanking the page.
    const assets = await Promise.all(
      store.assets.map(async (a) => {
        try {
          const { price, d24, d7, d30, d1a } = await lookupDetails({ assetClass: a.assetClass, symbol: a.symbol })
          // The ANDAMENTI chart's real line — since the EARLIEST lot's own
          // purchase date, not an arbitrary fixed window, so "Tutto" always
          // reads as "since I actually bought this". A history fetch failing
          // still leaves the price/deltas above intact — the chart just
          // falls back to nothing for that one asset rather than the page.
          const lotDates = (a.lots ?? []).map((l) => l.date).filter(Boolean).sort()
          let priceHistory = []
          try {
            priceHistory = await lookupHistory({ assetClass: a.assetClass, symbol: a.symbol, sinceIso: lotDates[0] })
          } catch (err) {
            console.error(`[jarvis] price history failed for ${a.symbol}:`, err?.message ?? err)
          }
          return { ...a, price, d24, d7, d30, d1a, priceHistory }
        } catch (err) {
          console.error(`[jarvis] price refresh failed for ${a.symbol}:`, err?.message ?? err)
          return a
        }
      }),
    )

    // The BTC/EUNL navbar chips shown on every LifeOS page — a fixed market
    // pulse, not tied to what's actually held (that's Finanze's own asset
    // table). Independent of the portfolio above; missing on a lookup
    // failure rather than blocking the rest of the page.
    const marketPulse = {}
    const [btcResult, eunlResult] = await Promise.allSettled([
      lookupDetails({ assetClass: 'crypto', symbol: 'BTC' }),
      lookupDetails({ assetClass: 'stock', symbol: 'EUNL' }),
    ])
    if (btcResult.status === 'fulfilled') marketPulse.btc = btcResult.value
    else console.error('[jarvis] BTC market pulse failed:', btcResult.reason?.message ?? btcResult.reason)
    if (eunlResult.status === 'fulfilled') marketPulse.eunl = eunlResult.value
    else console.error('[jarvis] EUNL market pulse failed:', eunlResult.reason?.message ?? eunlResult.reason)

    // Pulls in anything logged in the real FatSecret app today that LifeOS
    // doesn't have yet — the other half of the sync, see importFatsecretEntries
    // in lifeos-store.mjs for the dedupe logic. `store` was already loaded
    // above, so the newly-added records are folded in locally rather than
    // re-reading the file, but they ARE persisted (importFatsecretEntries
    // writes them). A hiccup here (not connected, network) just means
    // today's view doesn't include a diary sync this time, same fallback
    // shape as events/calendars above.
    const fatsecretAuth = await getFatsecretAuth()
    if (fatsecretAuth) {
      try {
        const entries = await getFoodEntries(fatsecretAuth.accessToken, fatsecretAuth.accessTokenSecret, localDateInt())
        const added = await importFatsecretEntries(entries)
        if (added.length) store.meals = store.meals.concat(added)
      } catch (err) {
        console.error('[jarvis] FatSecret diary import failed:', err?.message ?? err)
      }
    }

    const nutritionToday = summarizeMealsForToday(store.meals)
    // store.fatsecretAuth carries the real OAuth1 access token secret — never
    // shipped to the browser; fatsecretConnected (just a boolean) is all the
    // frontend needs to show connect/connected state.
    const { fatsecretAuth: _fatsecretAuthOmitted, ...storeForClient } = store

    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ...storeForClient, assets, events, latestHealth, calendarNames, calendarColors, marketPulse, didupVerifiche, didupCompiti, nutritionToday, automations, reviewWeek, fatsecretConnected: !!fatsecretAuth }))
  }

  // --- LifeOS pages, session-gated ----------------------------------------
  // Only reached for the fixed set of files lifeosFileFor() knows about — see
  // lifeos.mjs. Everything else falls through to the 404 below unchanged.
  if (req.method === 'GET') {
    const name = lifeosFileFor(new URL(req.url, 'http://x').pathname, BASE_PATH)
    if (name) {
      if (LIFEOS_AUTH_CONFIGURED && !sessionUserFor(req)) {
        res.writeHead(302, { ...cors, location: `${LOGIN_PATH}?next=${encodeURIComponent(req.url)}` })
        return res.end()
      }
      return serveLifeosFile(name, res, cors)
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws' && path !== WS_PATH) {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    if (requiresSession(origin) && !sessionUserFor(req)) {
      console.warn(`[jarvis] rejected websocket from ${origin} — no valid LifeOS session`)
      return done(false, 401, 'Unauthorized')
    }
    done(true)
  },
})
// Bound to all interfaces by default, exactly as before. Set JARVIS_BRIDGE_HOST
// to 127.0.0.1 on a deployment sitting behind a reverse proxy, so the raw
// bridge — Origin-checked but not TLS-terminated — is never reachable except
// through that proxy.
const BRIDGE_HOST = process.env.JARVIS_BRIDGE_HOST || undefined
if (BRIDGE_HOST) server.listen(PORT, BRIDGE_HOST)
else server.listen(PORT)

startRecurringBuyScheduler()
startVerificheSyncScheduler()

console.log(`[jarvis] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[jarvis] speech ${elevenKey() ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
)
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)
console.log(
  LIFEOS_AUTH_CONFIGURED
    ? `[jarvis] LifeOS pages served, login required for ${LIFEOS_USERNAME} on non-local origins`
    : '[jarvis] LifeOS pages served with NO LOGIN — set LIFEOS_USERNAME/PASSWORD_HASH/SESSION_SECRET before exposing this bridge publicly',
)
console.log(
  QWEN_URL
    ? `[jarvis] local model (Qwen2.5) available at ${QWEN_URL}`
    : '[jarvis] local model not configured — set QWEN_URL to offer it as a model in the LifeOS pages',
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * The local-model path: a single non-streaming call to llama-server's
   * OpenAI-compatible endpoint, offering the tools that section is allowed
   * to use (see lifeos-tools.mjs). Non-streaming because a tool call arrives
   * as one JSON object, not text worth showing token-by-token — these are
   * short confirmations, not essays. Independent of the Claude session's
   * turn queue: nothing here shares state with it, so requests just run as
   * they arrive.
   *
   * The reply text is NEVER the model's own claim of success — it's built
   * from the record lifeos-tools.mjs actually wrote (see runTool's
   * `confirm`). A tool call that fails to write never gets a confirmation.
   */
  async function runLocalModel(text, id, section) {
    answering = id
    if (!QWEN_URL) {
      sendTurn({ type: 'error', message: 'Il modello locale non è configurato su questo bridge.' })
      return
    }
    try {
      const tools = toolsForSection(section)
      const res = await fetch(QWEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(QWEN_API_KEY ? { authorization: `Bearer ${QWEN_API_KEY}` } : {}),
        },
        // A tool call that never terminates would otherwise hang the request
        // indefinitely — measured on MiniCPM under a different schema, where
        // the model generated past 1000 tokens without closing its JSON.
        // The "home" section offers all four tools at once, so its prompt is
        // roughly 4x longer than a single-tool section's — measured over
        // 90s on this Pi before that extra prompt-processing time is done.
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: process.env.QWEN_MODEL || 'qwen2.5-3b',
          stream: false,
          max_tokens: 400,
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPromptFor(section) },
            { role: 'user', content: text },
          ],
          ...(tools.length ? { tools } : {}),
        }),
      })
      if (!res.ok) {
        sendTurn({ type: 'error', message: `Il modello locale ha risposto ${res.status}.` })
        return
      }
      const data = await res.json()
      const message = data.choices?.[0]?.message
      const calls = (message?.tool_calls ?? []).map((c) => c.function).filter(Boolean)
      if (calls.length) {
        const confirms = []
        let lastRecord = null
        let lastAction = null
        for (const call of calls) {
          let args
          try {
            args = JSON.parse(call.arguments || '{}')
          } catch {
            confirms.push('Ho proposto un’azione non valida.')
            continue
          }
          try {
            const { record, confirm, action } = await runTool(call.name, args)
            confirms.push(confirm)
            lastRecord = record
            lastAction = action
          } catch (err) {
            // A bad/empty argument (amount 0, blank name…) is a clarifying
            // question, not a failure — and definitely not a fabricated record.
            if (err instanceof ActionValidationError) confirms.push(err.message)
            else throw err
          }
        }
        sendTurn({ type: 'done', text: confirms.join('\n'), data: lastRecord, action: lastAction })
        return
      }
      sendTurn({ type: 'done', text: message?.content || '...' })
    } catch (err) {
      sendTurn({
        type: 'error',
        message: `Modello locale non raggiungibile: ${err?.message ?? err}`,
      })
    }
  }

  /**
   * The Gemini path: one non-streaming call to the Generative Language
   * API's generateContent endpoint. No tools — sections routed here are
   * analysis/chat only, nothing to write — so unlike runLocalModel this
   * never touches lifeos-tools.mjs.
   */
  async function runGeminiModel(text, id, section) {
    answering = id
    const { geminiApiKey } = await getSettings()
    if (!geminiApiKey) {
      sendTurn({ type: 'error', message: 'La chiave API di Gemini non è configurata: aggiungila dal tuo Profilo.' })
      return
    }
    // Review gets its last 8 weeks of real habit data folded into the
    // system instruction — the only way this "no tools" path can answer
    // "genera un riepilogo" or "confronta con la settimana scorsa / la
    // settimana 35" with real numbers instead of making something up.
    // Gemini itself figures out which week(s) the question means; nothing
    // here parses "scorsa" or a week number, the data for all of them is
    // just already in front of it.
    let contextBlock = ''
    if (section === 'review') {
      try {
        const store = await getStore()
        const weeks = recentWeekSummaries(store.habits, new Date(), 8)
        contextBlock =
          '\n\nDati reali delle ultime 8 settimane (solo abitudini — i promemoria completati non lasciano storico), dalla più recente:\n\n' +
          weeks.map(formatWeekSummary).join('\n\n')
      } catch (err) {
        console.error('[jarvis] review week summary for Gemini failed:', err?.message ?? err)
      }
    }
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPromptFor(section) + contextBlock }] },
            contents: [{ role: 'user', parts: [{ text }] }],
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        sendTurn({ type: 'error', message: body?.error?.message || `Gemini ha risposto ${res.status}.` })
        return
      }
      const data = await res.json()
      const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '...'
      sendTurn({ type: 'done', text: reply })
    } catch (err) {
      sendTurn({ type: 'error', message: `Gemini non raggiungibile: ${err?.message ?? err}` })
    }
  }

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  const session = query({
    prompt: userMessages(),
    options: {
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        jarvis: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `jarvis_ui` explicitly.
        jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES }),
        // The camera, which unlike everything else here has to ask and wait.
        jarvis_eyes: visionServer(ask),
        // Real cron automations — plan in conversation, write the script
        // with the normal tools, schedule it for real here. See
        // lifeos-cron.mjs. Gated by the generic verb rules below, same as
        // any other MCP server not hand-exempted above.
        jarvis_cron: lifeosCronServer(),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn.
      systemPrompt: SYSTEM_PROMPT,
      // Run from the home directory so project-scoped MCP servers don't shadow
      // the global ones, and so file tools have a sane root.
      cwd: homedir(),
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and JARVIS
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is a last gate, not the only one. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: echo hello` without asking, and only reaches us for
      // something with a consequence, like a `touch`. So a deny here is
      // reliable; an absence of a call here is not proof nothing ran.
      canUseTool: async (toolName) => {
        const ok = decideTool(toolName)
        console.log(`[jarvis] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
        return ok
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona is forbidden from saying one aloud.
              message:
                'Blocked: JARVIS is running in read-only mode and cannot take' +
                ' actions that change anything. Tell the user this action is' +
                ' unavailable until they enable write access on the machine.',
            }
      },
    },
  })

  // Pump the session's output stream to the browser for as long as it lives.
  ;(async () => {
    try {
      for await (const msg of session) {
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and JARVIS stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
              })
            } else {
              console.error(
                `[jarvis] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[jarvis] ${usable.length} MCP servers available`)
            }
            break
        }
      }
    } catch (err) {
      console.error('[jarvis] session error:', err)
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      if (msg.model === 'qwen') {
        const section = typeof msg.section === 'string' ? msg.section : null
        void runLocalModel(text, id, section)
      } else if (msg.model === 'gemini') {
        const section = typeof msg.section === 'string' ? msg.section : null
        void runGeminiModel(text, id, section)
      } else {
        void settling.then(() => {
          answering = id
          if (deliver) {
            const resolve = deliver
            deliver = null
            resolve(text)
          } else {
            inbox.push(text)
          }
        })
      }
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt') {
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    closed = true
    deliver?.(null)
    session.close?.()
  })
})
