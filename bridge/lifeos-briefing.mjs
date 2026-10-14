/**
 * The 06:00 Telegram briefing (hermes-agent's harness.morning_briefing), for the LifeOS home.
 * morning_briefing.py keeps a copy of what it sends in data/morning_briefing.json; this only reads
 * that file and splits the text into the five sections the briefing's prompt asks for.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HERMES_DIR } from './cron-utils.mjs'

const FILE = join(HERMES_DIR, 'data', 'morning_briefing.json')

// "**☀️ Meteo**" on a line of its own — emoji, then the title.
const HEADER = /^\*\*\s*(\p{Extended_Pictographic}️?)\s*(.+?)\s*\*\*\s*$/u

const KEYS = [
  ['meteo', 'meteo'],
  ['mercati', 'mercati'],
  ['impegni', 'impegni'],
  ['email', 'email'],
  ['promemoria', 'promemoria'],
]

function keyFor(title) {
  const t = title.toLowerCase()
  return KEYS.find(([needle]) => t.includes(needle))?.[1] ?? t.replace(/\W+/g, '-')
}

export function parseBriefing(text) {
  const sections = []
  let current = null
  for (const line of String(text ?? '').split('\n')) {
    const m = HEADER.exec(line.trim())
    if (m) {
      current = { key: keyFor(m[2]), emoji: m[1], title: m[2], lines: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return sections.map(({ lines, ...s }) => ({ ...s, text: lines.join('\n').trim() }))
}

/** Latest saved briefing, or null if none has been generated yet. */
export async function getBriefing() {
  let raw
  try {
    raw = JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    return null
  }
  return { generatedAtIso: raw.generatedAtIso ?? null, sections: parseBriefing(raw.text) }
}
