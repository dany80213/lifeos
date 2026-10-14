// Minimal WebSocket client for the LifeOS pages' "chat with Jarvis" bars.
// Speaks the same protocol as src/lib/bridge.ts: {type:'ask', text, id} out,
// {type:'text'|'tool'|'done'|'error', ask:id, ...} in, filtered by matching id.
// Served same-origin by the bridge (see bridge/lifeos.mjs), so it connects
// back to its own host — no separate port or CORS to configure.
//
// Which backend answers a question is per-SECTION, not global: Profilo's
// "ASSISTENTE PER SEZIONE" list (see Profilo.dc.html) assigns one of the "Le
// mie IA" models to each section, stored here under one shared localStorage
// key so every page reads the same assignments. Picking "Qwen2.5 (locale)"
// routes to bridge/server.mjs's runLocalModel, which can actually act
// (add_transaction/add_meal/add_event/add_reminder — see lifeos-tools.mjs),
// scoped to what that section is allowed to do. Picking "Gemini" routes to
// runGeminiModel instead — plain analysis/chat, no tools — using the API
// key set in Profilo (getSettings/setSettings below), never an env var.
// The JARVIS card on the Home page (tool-using, automations) is a separate
// thing entirely and never goes through this — it always talks to the real
// Jarvis and doesn't call ask() with a section.
(function () {
  let socket = null;
  let connecting = null;
  let askSeq = 0;
  const pending = new Map(); // id -> { text, onDelta, resolve, reject }

  const SECTIONS_KEY = 'lifeos_section_ai';
  // 'Jarvis Pro' and 'Jarvis Lite' used to be the defaults here, but
  // backendFor below only ever recognised the Qwen/Gemini names specially —
  // every other label, "Jarvis Pro" and "Jarvis Lite" included, fell through
  // to the exact same real backend (the full Claude Agent SDK session). So
  // the two names were never actually two different things; this just says
  // what they both already were.
  const DEFAULT_SECTIONS = {
    home: 'Claude',
    finanze: 'Claude',
    investimenti: 'Claude',
    salute: 'Claude',
    // Review's chat is Gemini by default — see runGeminiModel in
    // server.mjs, which feeds it 8 weeks of real habit history so it can
    // actually generate a summary or compare weeks, not just talk about it.
    review: 'Gemini',
  };
  // Must match the option's `name` in Profilo.dc.html's aiModels list exactly.
  const LOCAL_MODEL_NAME = 'Groq';
  const GEMINI_MODEL_NAME = 'Gemini';

  // One shared key so the dark/light choice made on any page (the nav
  // switch, or Profilo's TEMA PREDEFINITO) is the same on every other page
  // and survives a reload — before this each page's `theme` was its own
  // component state, reset to 'dark' every time, which is what made the
  // toggle feel broken: it "worked" for as long as you stayed on one page.
  const THEME_KEY = 'lifeos_theme';
  function getTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : 'dark';
    } catch {
      return 'dark';
    }
  }
  function setTheme(theme) {
    pushProfile({ theme: theme === 'light' ? 'light' : 'dark' });
    try {
      localStorage.setItem(THEME_KEY, theme === 'light' ? 'light' : 'dark');
    } catch {
      // Private browsing or storage disabled — the choice just won't persist.
    }
  }

  function getSectionAssignments() {
    try {
      const raw = localStorage.getItem(SECTIONS_KEY);
      return raw ? { ...DEFAULT_SECTIONS, ...JSON.parse(raw) } : { ...DEFAULT_SECTIONS };
    } catch {
      return { ...DEFAULT_SECTIONS };
    }
  }
  function setSectionAssignments(next) {
    pushProfile({ sectionAI: next });
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {
      // Private browsing or storage disabled — the choice just won't persist.
    }
  }
  function backendFor(section) {
    if (!section) return 'jarvis';
    const model = getSectionAssignments()[section];
    if (model === LOCAL_MODEL_NAME || /^Qwen/.test(model || '')) return 'qwen'; // 'Qwen…' = value saved before the rename
    if (model === GEMINI_MODEL_NAME) return 'gemini';
    return 'jarvis';
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The directory this page lives in — '' at the root, or e.g. '/lifeos'
    // when the app is mounted under a path prefix. Derived from the page's
    // own URL so this file needs no server-side templating either way.
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    return proto + '//' + location.host + dir + '/ws';
  }

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        socket = ws;
        connecting = null;
        resolve(ws);
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const slot = msg.ask ? pending.get(msg.ask) : null;
        if (!slot) return;
        if (msg.type === 'text') {
          slot.text += msg.delta ?? '';
          slot.onDelta?.(msg.delta ?? '');
        } else if (msg.type === 'done') {
          pending.delete(msg.ask);
          slot.resolve({ text: msg.text || slot.text, data: msg.data ?? null, action: msg.action ?? null });
        } else if (msg.type === 'error') {
          pending.delete(msg.ask);
          slot.reject(new Error(msg.message || 'Jarvis non ha risposto.'));
        }
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        connecting = null;
        reject(new Error('connessione a Jarvis interrotta'));
      };
      ws.onerror = () => {};
    });
    return connecting;
  }

  /**
   * Sends one question, resolves with { text, data, action }.
   * `data`/`action` are only set when the local model actually performed one
   * of the LifeOS actions — see lifeos-tools.mjs — and `data` is the exact
   * record it wrote, ready to splice into the page's own list.
   * `section` (e.g. 'finanze', 'salute', 'review', 'home') picks the model
   * via Profilo's per-section assignment and, for the local model, which
   * actions it's allowed to call; omit it to always use Jarvis with no tools.
   */
  async function ask(text, onDelta, section) {
    const ws = await connect();
    const id = 'lifeos' + (++askSeq);
    const model = backendFor(section);
    return new Promise((resolve, reject) => {
      pending.set(id, { text: '', onDelta, resolve, reject });
      ws.send(JSON.stringify({ type: 'ask', text, id, model, section }));
    });
  }

  /** Fetches everything a chat action has ever written — for a page's mount. */
  async function fetchData() {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-data', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('impossibile leggere i dati di LifeOS');
    return res.json();
  }

  /** Ends the FatSecret diary link — the connect half is a real OAuth redirect, not a fetch, so Profilo navigates to /api/lifeos-fatsecret-connect directly instead of calling a function here. */
  async function disconnectFatsecret() {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-fatsecret-disconnect', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) throw new Error('disconnessione FatSecret non riuscita');
    return res.json();
  }

  /** Reads Profilo's server-side settings (currently just the Gemini API key). */
  async function getSettings() {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-settings', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('impossibile leggere le impostazioni');
    return res.json();
  }

  /** Saves a partial update to Profilo's server-side settings. */
  async function setSettings(fields) {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error('impossibile salvare le impostazioni');
    return res.json();
  }

  /** Adds a LifeOS reminder — the home page's quick-add todo box uses this. */
  async function addReminder(text, dueIso) {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-reminder-add', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, due_iso: dueIso ?? null }),
    });
    if (!res.ok) throw new Error('impossibile salvare il promemoria');
    return res.json();
  }

  /** Marks a LifeOS reminder done — deletes it server-side so it stops coming back on reload. */
  async function completeReminder(id) {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-reminder-complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error('impossibile completare il promemoria');
    return res.json();
  }

  /** Add/edit/remove a row in Finanze's accounts/liabilities/assets — see lifeos-finance in server.mjs. */
  async function financeOp(collection, op, args) {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    const res = await fetch(dir + '/api/lifeos-finance', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection, op, ...args }),
    });
    if (!res.ok) {
      // The asset-add path replies with a specific reason (e.g. "simbolo non
      // riconosciuto") when a market lookup fails — surface that instead of
      // a generic message whenever the body actually has one.
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || ('operazione non riuscita (' + collection + '/' + op + ')'));
    }
    return res.json();
  }

  // Which Apple calendars the Home page's week grid shows — a per-viewer
  // preference, not something the server needs to know (it always reads all
  // non-excluded calendars; filtering happens client-side). `null` means "no
  // preference recorded yet", which the page treats as "show everything".
  const CALENDARS_KEY = 'lifeos_visible_calendars';
  function getVisibleCalendars() {
    try {
      const raw = localStorage.getItem(CALENDARS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function setVisibleCalendars(names) {
    pushProfile({ visibleCalendars: names });
    try {
      localStorage.setItem(CALENDARS_KEY, JSON.stringify(names));
    } catch {
      // Private browsing or storage disabled — the choice just won't persist.
    }
  }

  // Profile preferences live on the server (settings.profile) so the iOS app and every browser share them.
  // localStorage stays as the instant, offline copy the pages read synchronously; this refreshes it from the
  // server once per page load (the new values apply from the next read / reload) and pushes every change.
  function pushProfile(profile) {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    fetch(dir + '/api/lifeos-settings', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile }),
    }).catch(() => {});
  }
  // The latest profile from the server, for pages that render personal details / the photo.
  let profileCache = null;
  const profileListeners = [];
  function getProfile() { return profileCache; }
  function onProfile(fn) { profileListeners.push(fn); if (profileCache) fn(profileCache); }
  function setProfile(fields) {
    pushProfile(fields);
    profileCache = Object.assign({}, profileCache || {}, fields);
    applyPhoto();
  }

  // Every round "D" avatar in the pages (navbar, home card) becomes the profile photo when there is one.
  // The pages hard-code the letter, so this looks for round, small, single-letter "D" boxes instead of
  // touching each page's template.
  function applyPhoto() {
    const photo = profileCache && profileCache.photo;
    document.querySelectorAll('div').forEach((el) => {
      if (el.dataset.lifeosAvatar) {
        if (photo) el.style.backgroundImage = 'url(' + photo + ')';
        return;
      }
      if (!photo || el.children.length || el.textContent.trim() !== 'D') return;
      const r = el.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      if (r.width < 24 || r.width > 140 || Math.abs(r.width - r.height) > 2 || radius < r.width / 4) return;
      el.dataset.lifeosAvatar = '1';
      el.textContent = '';
      el.style.backgroundImage = 'url(' + photo + ')';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    });
    const slot = document.getElementById('profilePhoto');
    if (slot && photo && slot.getAttribute('src') !== photo) slot.setAttribute('src', photo);
  }
  new MutationObserver(() => { if (profileCache && profileCache.photo) applyPhoto(); })
    .observe(document.documentElement, { childList: true, subtree: true });

  (function pullProfile() {
    const dir = location.pathname.replace(/\/[^/]*$/, '');
    fetch(dir + '/api/lifeos-settings', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((settings) => {
        const p = settings && settings.profile;
        if (!p) return;
        profileCache = p;
        profileListeners.forEach((fn) => fn(p));
        applyPhoto();
        try {
          if (p.theme) localStorage.setItem(THEME_KEY, p.theme);
          if (p.sectionAI) localStorage.setItem(SECTIONS_KEY, JSON.stringify(p.sectionAI));
          if (Array.isArray(p.visibleCalendars)) localStorage.setItem(CALENDARS_KEY, JSON.stringify(p.visibleCalendars));
        } catch {
          // storage disabled — the server copy still applies to the other clients.
        }
      })
      .catch(() => {});
  })();

  window.LifeOSJarvis = {
    ask, fetchData, addReminder, completeReminder, financeOp, getSectionAssignments, setSectionAssignments, getVisibleCalendars, setVisibleCalendars,
    getSettings, setSettings, getProfile, onProfile, setProfile, getTheme, setTheme, disconnectFatsecret,
  };
})();
