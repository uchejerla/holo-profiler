/* Hosted app bridge: gives the page its workspace store, data sources and server runs through the app's own API.
   Loaded before the other page scripts only in the hosted build (scripts/build-hud.mjs). */
(function () {
'use strict';
const cfg = window.__HOLO_CONFIG || {};
const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();

async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: Object.assign({ 'x-holo': '1', 'x-holo-tz': tz }, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) { const err = new Error('Network error'); err.code = 'unavailable'; throw err; }
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const err = new Error((j && j.error) || ('Request failed (' + r.status + ')'));
    err.code = r.status === 401 ? 'signed_out' : r.status === 409 ? 'conflict' : r.status === 413 ? 'invalid_argument' : r.status === 429 ? 'resource_exhausted' : r.status >= 500 ? 'unavailable' : (j && j.code) || 'failed';
    if (r.status === 401) showSignedOut();
    throw err;
  }
  return j || {};
}
const seg = s => encodeURIComponent(String(s));

window.HoloServer = {
  user: cfg.user || null, workspace: cfg.workspace || null, tz,
  store: {
    load: () => api('GET', '/api/store'),
    write: (c, id, o) => o ? api('PUT', '/api/store/' + seg(c) + '/' + seg(id), o) : api('DELETE', '/api/store/' + seg(c) + '/' + seg(id))
  },
  sources: {
    list: () => api('GET', '/api/sources'),
    create: o => api('POST', '/api/sources', o),
    remove: id => api('DELETE', '/api/sources/' + seg(id)),
    test: id => api('POST', '/api/sources/' + seg(id) + '/test')
  },
  schedules: () => api('GET', '/api/schedules'),
  runNow: dsId => api('POST', '/api/datasets/' + seg(dsId) + '/run')
};

function showSignedOut() {
  if (document.getElementById('holoSignedOut')) return;
  const d = document.createElement('div');
  d.id = 'holoSignedOut'; d.className = 'acctbar warn'; d.setAttribute('role', 'alert');
  d.innerHTML = 'Your session ended. <a href="/login?next=/app">Sign in again</a> to keep saving.';
  document.body.appendChild(d);
}

// Account chip in the top bar.
function mountAccount() {
  const bar = document.querySelector('.topbar .actions');
  if (!bar || document.getElementById('acct')) return;
  const w = document.createElement('div');
  w.className = 'acct'; w.id = 'acct';
  const who = (cfg.user && cfg.user.email) || 'Signed in';
  const ws = (cfg.workspace && cfg.workspace.name) || '';
  w.innerHTML = '<span class="acct-who" title=""></span><form method="post" action="/auth/signout"><button class="mini" type="submit">Sign out</button></form>';
  w.querySelector('.acct-who').textContent = ws ? who + ' · ' + ws : who;
  w.querySelector('.acct-who').title = ws ? 'Workspace: ' + ws : '';
  // Upgrade (free) or Billing (pro), for the people who can pay: owners and admins.
  const role = cfg.workspace && cfg.workspace.role;
  if (cfg.billing && (role === 'owner' || role === 'admin')) {
    const pro = cfg.workspace.plan === 'pro';
    const a = document.createElement('a');
    a.className = 'mini'; a.href = pro ? '/upgrade' : '/#pricing'; a.textContent = pro ? 'Billing' : 'Upgrade to Pro';
    w.insertBefore(a, w.querySelector('form'));
  }
  bar.appendChild(w);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAccount); else mountAccount();
})();
