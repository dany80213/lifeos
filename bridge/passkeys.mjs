/**
 * Passkeys (WebAuthn) for the LifeOS login — a second way in next to the password.
 *
 * Credentials live in data/lifeos-passkeys.json, deliberately NOT in the settings object the pages read
 * (settings are sent to every client). Public keys are not secret, but there is no reason to ship them.
 * The relying-party id is the public host name; the browser checks the origin (scheme + host + port)
 * against LIFEOS_PASSKEY_ORIGINS, so the non-standard :8444 is fine for web.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'

const FILE = fileURLToPath(new URL('../data/lifeos-passkeys.json', import.meta.url))
const RP_NAME = 'LifeOS'
const RP_ID = process.env.LIFEOS_PASSKEY_RP_ID || 'localhost'
const ORIGINS = (process.env.LIFEOS_PASSKEY_ORIGINS || 'http://localhost:8787')
  .split(',').map((s) => s.trim()).filter(Boolean)
const CHALLENGE_TTL_MS = 5 * 60 * 1000

const challenges = new Map() // id -> { challenge, kind, exp }

function remember(kind, challenge) {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k)
  const id = randomBytes(16).toString('base64url')
  challenges.set(id, { challenge, kind, exp: now + CHALLENGE_TTL_MS })
  return id
}

/** One use only: a challenge that was answered (or failed) can never be replayed. */
function take(id, kind) {
  const c = challenges.get(id)
  challenges.delete(id)
  if (!c || c.kind !== kind || c.exp < Date.now()) return null
  return c.challenge
}

async function load() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'))
  } catch {
    return { credentials: [] }
  }
}

let writing = Promise.resolve()
function save(data) {
  writing = writing.then(async () => {
    await mkdir(dirname(FILE), { recursive: true })
    const tmp = `${FILE}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, FILE)
  })
  return writing
}

const toB64 = (u8) => Buffer.from(u8).toString('base64url')
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'))

export async function listPasskeys() {
  return (await load()).credentials.map(({ id, name, createdAtIso, lastUsedIso }) => ({ id, name, createdAtIso, lastUsedIso }))
}

export async function removePasskey(id) {
  const data = await load()
  const before = data.credentials.length
  data.credentials = data.credentials.filter((c) => c.id !== id)
  await save(data)
  return { removed: data.credentials.length < before }
}

export async function hasPasskeys() {
  return (await load()).credentials.length > 0
}

export async function registrationOptions(username) {
  const data = await load()
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    userID: new TextEncoder().encode(username),
    attestationType: 'none',
    excludeCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  })
  return { cid: remember('register', options.challenge), options }
}

export async function registrationVerify({ cid, response, name }) {
  const expectedChallenge = take(cid, 'register')
  if (!expectedChallenge) throw new Error('Richiesta scaduta, riprova.')
  const result = await verifyRegistrationResponse({
    response, expectedChallenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID, requireUserVerification: false,
  })
  if (!result.verified) throw new Error('Passkey non verificata.')
  const { credential } = result.registrationInfo
  const data = await load()
  if (data.credentials.some((c) => c.id === credential.id)) throw new Error('Passkey già registrata.')
  data.credentials.push({
    id: credential.id,
    publicKey: toB64(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    name: String(name || 'Passkey').slice(0, 60),
    createdAtIso: new Date().toISOString(),
    lastUsedIso: null,
  })
  await save(data)
  return { id: credential.id }
}

export async function authenticationOptions() {
  // No allowCredentials: the passkey is discoverable, so the device offers whichever one it holds for this site.
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' })
  return { cid: remember('login', options.challenge), options }
}

/** Returns true only if the assertion verifies against a stored passkey; bumps its counter. */
export async function authenticationVerify({ cid, response }) {
  const expectedChallenge = take(cid, 'login')
  if (!expectedChallenge) return false
  const data = await load()
  const stored = data.credentials.find((c) => c.id === response?.id)
  if (!stored) return false
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGINS,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: { id: stored.id, publicKey: fromB64(stored.publicKey), counter: stored.counter, transports: stored.transports },
    })
    if (!result.verified) return false
    stored.counter = result.authenticationInfo.newCounter
    stored.lastUsedIso = new Date().toISOString()
    await save(data)
    return true
  } catch (err) {
    console.warn('[jarvis] passkey login rejected:', err?.message ?? err)
    return false
  }
}
