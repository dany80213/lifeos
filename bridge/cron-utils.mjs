/**
 * Shared crontab reading/writing for hermes-agent's scheduled jobs — used by
 * both lifeos-automations.mjs (the read-only AUTOMAZIONI card) and
 * lifeos-cron.mjs (Claude's tool to actually create/edit/remove one).
 *
 * Every job this code manages runs the same shape of command — a harness
 * module, invoked through uv, inside hermes-agent — and is preceded by a
 * `# jarvis: <description>` comment line once it goes through add_cron_job.
 * Hand-authored entries from before this tool existed have no such comment;
 * they're still recognized by the command shape alone, just with no
 * description to show beyond what the static catalogue or the module's own
 * docstring supplies — see lifeos-automations.mjs.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * `execFile`'s callback/promisified form has no `input` option — that only
 * exists on `execFileSync`. Passing one there is silently ignored, which is
 * exactly how this broke the first time: `crontab -` inherited this
 * process's own stdin, got nothing, and hung forever instead of installing
 * anything. This writes to the child's stdin directly and closes it.
 */
function runWithInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(stderr.trim() || `${cmd} exited with code ${code}`), { code, stdout, stderr }))
    })
    child.stdin.end(input)
  })
}

export const HERMES_DIR = process.env.HERMES_AGENT_DIR || join(homedir(), 'hermes-agent')
export const UV_BIN = process.env.UV_BIN || join(homedir(), '.local', 'bin', 'uv')

const COMMENT_RE = /^#\s*jarvis:\s*(.+)$/i
// Captures the 5 schedule fields and the module name out of a line this
// tool could have written. Escaped once here so add/remove/list agree
// byte-for-byte on what counts as "one of ours".
const CRON_FIELDS = String.raw`(\S+\s+\S+\s+\S+\s+\S+\s+\S+)`
const commandRe = () =>
  new RegExp(
    `^${CRON_FIELDS}\\s+cd ${escapeRe(HERMES_DIR)} && ${escapeRe(UV_BIN)} run python -m harness\\.([a-z][a-z0-9_]*) >> ${escapeRe(HERMES_DIR)}/[a-z0-9_]+\\.log 2>&1\\s*$`,
  )

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The exact command line add_cron_job writes for a given module — the only shape list/remove ever match against. */
export function commandFor(module) {
  return `cd ${HERMES_DIR} && ${UV_BIN} run python -m harness.${module} >> ${HERMES_DIR}/${module}.log 2>&1`
}

export async function readCrontabText() {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l'])
    return stdout
  } catch {
    return ''
  }
}

/** Overwrites the whole crontab — always with a timestamped backup first, so any mistake is a `crontab backups/<ts>` away from undone. */
export async function writeCrontabText(text) {
  const before = await readCrontabText()
  const backupDir = join(homedir(), '.crontab-backups')
  await mkdir(backupDir, { recursive: true })
  const ts = Math.floor(Date.now() / 1000)
  await writeFile(join(backupDir, `crontab.${ts}`), before).catch(() => {})
  await runWithInput('crontab', ['-'], text)
}

/**
 * Parses the crontab into a flat line array (so a rewrite can preserve
 * everything untouched — backup.sh, telegram_archiver, netflix_bot) plus
 * the subset of lines that are harness.<module> jobs this tool understands,
 * each with its line index(es) so add/update/remove can splice precisely.
 */
export function parseCrontab(text) {
  const lines = text.split('\n')
  const re = commandRe()
  const jobs = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // A `# jarvis: …` line is a description, read when we hit the command
    // line below it, not a job line of its own.
    if (COMMENT_RE.test(raw)) continue
    // A disabled job is the same line with a leading `#` — still ours, just
    // paused; strip it to test the shape without losing that it was commented.
    const disabled = /^\s*#/.test(raw)
    const probe = disabled ? raw.replace(/^\s*#\s*/, '') : raw
    const m = re.exec(probe)
    if (!m) continue
    const [, schedule, module] = m
    const commentIdx = COMMENT_RE.test(lines[i - 1] ?? '') ? i - 1 : -1
    const description = commentIdx >= 0 ? COMMENT_RE.exec(lines[commentIdx])[1].trim() : ''
    jobs.push({ module, schedule, description, enabled: !disabled, commentLine: commentIdx, commandLine: i })
  }
  return { lines, jobs }
}

// Per-field numeric bounds — minute, hour, day-of-month, month, day-of-week.
// Checked explicitly rather than leaving range validation to `crontab -`:
// that command rejects an out-of-range value by refusing to install the
// WHOLE file, and writeCrontabText has already backed up and would need to
// unwind a partial state. Catching it here, before any write is attempted,
// is simpler and gives a better error besides.
const FIELD_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

function validField([lo, hi], field) {
  return field.split(',').every((part) => {
    const [range, step] = part.split('/')
    if (step !== undefined && !/^\d+$/.test(step)) return false
    if (range === '*') return true
    const m = /^(\d+)(?:-(\d+))?$/.exec(range)
    if (!m) return false
    const a = Number(m[1])
    const b = m[2] !== undefined ? Number(m[2]) : a
    return a >= lo && a <= hi && b >= lo && b <= hi && a <= b
  })
}

/** 5-field cron schedule, each field a number/`*`/range/step/list, bounds-checked per field. */
export function isValidSchedule(schedule) {
  const fields = String(schedule ?? '').trim().split(/\s+/)
  return fields.length === 5 && fields.every((f, i) => validField(FIELD_BOUNDS[i], f))
}

export function scriptExists(module) {
  return existsSync(join(HERMES_DIR, 'harness', `${module}.py`))
}

export { execFileAsync }
