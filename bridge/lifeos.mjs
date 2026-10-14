/**
 * Static serving for the LifeOS pages (web/lifeos/), from inside the same
 * process as the bridge — so one login and one WebSocket connection cover
 * both the pages and the AI chat embedded in them.
 *
 * Only the exact files below are ever read. There is no general static-file
 * serving here on purpose: this is a fixed, small set of pages, not a public
 * file server.
 */

import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../web/lifeos/', import.meta.url))

const PAGES = new Set([
  'LifeOS.dc.html',
  'Profilo.dc.html',
  'Finanze.dc.html',
  'Review.dc.html',
  'Salute e Nutrizione.dc.html',
])
const ASSETS = new Set(['support.js', 'image-slot.js', 'jarvis-client.js'])

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
}

/**
 * Maps a request path to a filename under web/lifeos/, or null if it isn't
 * one. `basePath` (e.g. "/lifeos", no trailing slash) is stripped first when
 * the app is mounted under a prefix — see LIFEOS_BASE_PATH in server.mjs.
 */
export function lifeosFileFor(pathname, basePath = '') {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (basePath) {
    if (decoded === basePath) decoded = '/'
    else if (decoded.startsWith(basePath + '/')) decoded = decoded.slice(basePath.length)
    else return null
  }
  if (decoded === '/' || decoded === '/index.html') return 'LifeOS.dc.html'
  const name = decoded.slice(1)
  if (PAGES.has(name) || ASSETS.has(name)) return name
  return null
}

export async function serveLifeosFile(name, res, corsHeaders) {
  try {
    const body = await readFile(join(ROOT, name))
    const type = CONTENT_TYPES[extname(name)] ?? 'application/octet-stream'
    res.writeHead(200, { ...corsHeaders, 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, corsHeaders)
    res.end('not found')
  }
}
