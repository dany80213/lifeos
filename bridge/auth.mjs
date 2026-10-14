/**
 * Login for the public LifeOS pages.
 *
 * The bridge's WebSocket is already gated by Origin (see server.mjs), which is
 * enough when the only client is a browser on localhost. Once the LifeOS pages
 * are served from a public domain, Origin alone is not enough — anyone who
 * finds the URL has a valid Origin. This adds a second, independent gate: a
 * signed session cookie, issued only after a correct username/password, that
 * both the static pages and the WebSocket upgrade require for any non-local
 * origin (see requiresSession in server.mjs).
 *
 * Single user, no database: one username/password pair lives in .env.local,
 * hashed with scrypt. `node scripts/lifeos-password.mjs <password>` prints the
 * hash to paste in.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'lifeos_session'
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const SCRYPT_KEYLEN = 64

export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  let salt, expected
  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  const actual = scryptSync(password, salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A signed, stateless session token: base64url(json).base64url(hmac). */
export function createSession(secret, username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + SESSION_MAX_AGE_MS }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Returns the username on a valid, unexpired token; null otherwise. */
export function verifySession(secret, token) {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot === -1) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null
    return typeof data.u === 'string' ? data.u : null
  } catch {
    return null
  }
}

export function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) {
      try {
        out[key] = decodeURIComponent(value)
      } catch {
        out[key] = value
      }
    }
  }
  return out
}

export function sessionCookieHeader(token) {
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
}

/** JSON that is safe inside an inline <script>: `<` and friends can never close the tag. */
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

export function renderLoginPage({ next = '/', error = null, loginPath = '/login', passkeys = false } = {}) {
  const base = loginPath.replace(/\/login$/, '')
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LifeOS</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: oklch(15% 0.03 280); color: oklch(97% 0.01 280); }
  form { display: flex; flex-direction: column; gap: 14px; width: min(340px, 88vw);
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.14); border-radius: 16px;
    padding: 28px; backdrop-filter: blur(20px); }
  h1 { font-size: 19px; font-weight: 800; margin: 0 0 4px; letter-spacing: -0.02em; }
  input { padding: 11px 14px; border-radius: 10px; background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.14);
    color: inherit; font-size: 14px; outline: none; font-family: inherit; }
  button { padding: 11px 0; border-radius: 10px; background: oklch(68% 0.13 235); color: white; font-size: 14px; font-weight: 700;
    border: none; cursor: pointer; }
  .err { font-size: 12.5px; color: oklch(68% 0.12 25); min-height: 1em; }
  button.alt { background: transparent; border: 1px solid rgba(255,255,255,0.2); }
</style></head>
<body>
  <form method="POST" action="${escapeHtml(loginPath)}">
    <h1>LifeOS</h1>
    <div class="err">${error ? escapeHtml(error) : ''}</div>
    <input type="text" name="username" placeholder="Utente" autocomplete="username" autofocus />
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" />
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <button type="submit">Accedi</button>
    ${passkeys ? '<button type="button" id="pk" class="alt">Entra con passkey</button>' : ''}
  </form>
  ${passkeys ? `<script>${PASSKEY_BROWSER_JS}
  const base = ${scriptJson(base)}, next = ${scriptJson(next)};
  document.getElementById('pk').addEventListener('click', async () => {
    const err = document.querySelector('.err');
    err.textContent = '';
    try {
      const target = await passkeyLogin(base);
      location.href = /^\\/(?!\\/)/.test(next || '') ? next : (/^\\/(?!\\/)/.test(target || '') ? target : base + '/');
    } catch (e) {
      err.textContent = e && e.name === 'NotAllowedError' ? 'Accesso annullato.' : 'Passkey non riconosciuta.';
    }
  });
  </script>` : ''}
</body></html>`
}

/** Browser-side WebAuthn helpers — plain JS, no bundler; shared by the login page and the passkeys page. */
const PASSKEY_BROWSER_JS = `
const b64u = {
  dec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer; },
  enc(buf) { let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); },
};
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error((await res.text()) || 'errore');
  return res.json();
}
async function passkeyLogin(base) {
  const o = await postJson(base + '/api/passkey/login-options');
  const pk = o.options;
  pk.challenge = b64u.dec(pk.challenge);
  (pk.allowCredentials || []).forEach(c => c.id = b64u.dec(c.id));
  const cred = await navigator.credentials.get({ publicKey: pk });
  const r = cred.response;
  const out = await postJson(base + '/api/passkey/login-verify', { cid: o.cid, response: {
    id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData),
      signature: b64u.enc(r.signature), userHandle: r.userHandle ? b64u.enc(r.userHandle) : undefined },
  } });
  return out.next;
}
async function passkeyRegister(base, name) {
  const o = await postJson(base + '/api/passkey/register-options');
  const pk = o.options;
  pk.challenge = b64u.dec(pk.challenge);
  pk.user.id = b64u.dec(pk.user.id);
  (pk.excludeCredentials || []).forEach(c => c.id = b64u.dec(c.id));
  const cred = await navigator.credentials.create({ publicKey: pk });
  const r = cred.response;
  return postJson(base + '/api/passkey/register-verify', { cid: o.cid, name, response: {
    id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64u.enc(r.clientDataJSON), attestationObject: b64u.enc(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : [] },
  } });
}
`

/** Page where a signed-in user adds, lists and removes passkeys. */
export function renderPasskeysPage({ base = '' } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Passkey · LifeOS</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif; background: oklch(15% 0.03 280); color: oklch(97% 0.01 280); }
  main { display: flex; flex-direction: column; gap: 14px; width: min(420px, 90vw);
    background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.14); border-radius: 16px; padding: 28px; }
  h1 { font-size: 19px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
  p { font-size: 13px; opacity: .7; margin: 0; line-height: 1.45; }
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,0.045); }
  .row div { flex: 1; font-size: 13.5px; } .row small { display: block; opacity: .55; font-size: 11.5px; margin-top: 2px; }
  button { padding: 11px 14px; border-radius: 10px; background: oklch(68% 0.13 235); color: white; font-size: 14px; font-weight: 700; border: none; cursor: pointer; }
  button.x { background: transparent; color: oklch(68% 0.12 25); padding: 4px 8px; font-size: 12.5px; }
  a { color: inherit; opacity: .6; font-size: 13px; } .msg { font-size: 12.5px; min-height: 1em; }
</style></head>
<body><main>
  <h1>Passkey</h1>
  <p>Accedi con Face ID, Touch ID o la chiave del tuo dispositivo, senza digitare la password. La password resta sempre valida.</p>
  <div id="list"></div>
  <button id="add">Aggiungi una passkey a questo dispositivo</button>
  <div class="msg" id="msg"></div>
  <a href="${escapeHtml(base)}/">← Torna a LifeOS</a>
</main>
<script>${PASSKEY_BROWSER_JS}
  const base = ${scriptJson(base)};
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : 'mai';
  async function refresh() {
    const { passkeys } = await (await fetch(base + '/api/passkey/list')).json();
    const list = document.getElementById('list');
    list.textContent = '';
    if (!passkeys.length) { list.innerHTML = '<p>Nessuna passkey registrata.</p>'; return; }
    for (const k of passkeys) {
      const row = document.createElement('div'); row.className = 'row';
      const info = document.createElement('div');
      info.textContent = k.name;
      const sub = document.createElement('small');
      sub.textContent = 'Aggiunta ' + fmt(k.createdAtIso) + ' · ultimo uso ' + fmt(k.lastUsedIso);
      info.appendChild(sub);
      const del = document.createElement('button'); del.className = 'x'; del.textContent = 'Rimuovi';
      del.onclick = async () => { await postJson(base + '/api/passkey/remove', { id: k.id }); refresh(); };
      row.append(info, del); list.appendChild(row);
    }
  }
  document.getElementById('add').onclick = async () => {
    const msg = document.getElementById('msg'); msg.textContent = '';
    const name = (navigator.userAgentData && navigator.userAgentData.platform) || (/iPhone/.test(navigator.userAgent) ? 'iPhone' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Dispositivo');
    try { await passkeyRegister(base, name); msg.textContent = 'Passkey aggiunta.'; refresh(); }
    catch (e) { msg.textContent = e && e.name === 'NotAllowedError' ? 'Operazione annullata.' : 'Non riuscito: ' + (e.message || e); }
  };
  refresh();
</script></body></html>`
}

/** Parses `key1=val1&key2=val2`, tolerant of a missing/garbled body. */
export function parseFormBody(body) {
  const out = {}
  for (const pair of String(body).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '))
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
    out[key] = value
  }
  return out
}
