import type { SavedRoute, User } from '../lib/types';

const app = document.getElementById('app')!;

function send<T = unknown>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp as T);
    });
  });
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]!);
}

function formatDistance(m?: number): string {
  if (!m) return '';
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatDuration(s?: number): string {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

const state: { user: User | null; routes: SavedRoute[] } = {
  user: null,
  routes: []
};

async function refresh(): Promise<void> {
  const u = await send<{ ok: boolean; user: User | null }>({ type: 'getUser' });
  state.user = u.user;
  if (state.user) {
    const r = await send<{ ok: boolean; routes?: SavedRoute[] }>({ type: 'getRoutes' });
    state.routes = r.routes ?? [];
  } else {
    state.routes = [];
  }
  render();
}

function render(): void {
  if (!state.user) {
    app.innerHTML = `
      <header><h1>Trasy pro mapy.com</h1></header>
      <section>
        <p class="empty">Přihlas se přes Seznam pro ukládání tras.</p>
        <button id="login">Přihlásit přes Seznam</button>
        <p id="err" class="error"></p>
      </section>
    `;
    document.getElementById('login')!.addEventListener('click', onLogin);
    return;
  }

  // We deliberately don't display the user's real name / email — we only
  // know they're authenticated, not who they are by name.
  app.innerHTML = `
    <header>
      <h1>Trasy pro mapy.com</h1>
      <div>
        <span class="user">Přihlášen</span>
        <button id="logout" class="secondary">Odhlásit</button>
      </div>
    </header>
    <section>
      <p class="hint">
        Pro přidání nové trasy otevři
        <a href="https://mapy.com" target="_blank">mapy.com</a>, klikni na
        tlačítko <strong>Trasy</strong> v horní liště nad mapou a vyber
        <strong>+ Nová trasa</strong>.
      </p>
      ${
        state.routes.length === 0
          ? `<p class="empty">Zatím nemáš žádné uložené trasy.</p>`
          : `<ul class="routes">${state.routes.map(routeItem).join('')}</ul>`
      }
    </section>
  `;

  document.getElementById('logout')!.addEventListener('click', onLogout);
  for (const r of state.routes) {
    document
      .querySelector(`[data-open="${r.id}"]`)
      ?.addEventListener('click', () => {
        chrome.tabs.create({ url: r.shareUrl });
      });
    document
      .querySelector(`[data-delete="${r.id}"]`)
      ?.addEventListener('click', async () => {
        await send({ type: 'deleteRoute', routeId: r.id });
        await refresh();
      });
  }
}

function routeItem(r: SavedRoute): string {
  const from = r.startLabel ?? `${r.start.lat.toFixed(4)}, ${r.start.lon.toFixed(4)}`;
  const to = r.endLabel ?? `${r.end.lat.toFixed(4)}, ${r.end.lon.toFixed(4)}`;
  const mode = r.routeType.replace(/_/g, ' ');
  const dist = formatDistance(r.distanceM);
  const dur = formatDuration(r.durationS);
  return `
    <li class="route">
      <div class="swatch" style="background:${escape(r.color)}"></div>
      <div>
        <div><strong>${escape(r.name)}</strong></div>
        <div class="meta">${escape(from)} → ${escape(to)}</div>
        <div class="meta">${escape(dist)}${dist && dur ? ' · ' : ''}${escape(dur)} · ${escape(mode)}</div>
      </div>
      <div class="actions">
        <button data-delete="${r.id}" class="danger" title="Delete">×</button>
      </div>
    </li>
  `;
}

async function onLogin(): Promise<void> {
  const btn = document.getElementById('login') as HTMLButtonElement;
  const err = document.getElementById('err')!;
  btn.disabled = true;
  err.textContent = '';
  try {
    const resp = await send<{ ok: boolean; error?: string }>({ type: 'login' });
    if (!resp.ok) throw new Error(resp.error ?? 'unknown error');
    await refresh();
  } catch (e: unknown) {
    err.textContent = e instanceof Error ? e.message : String(e);
    btn.disabled = false;
  }
}

async function onLogout(): Promise<void> {
  await send({ type: 'logout' });
  await refresh();
}

void refresh();
