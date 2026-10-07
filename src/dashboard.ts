/** Operator dashboard (GET /dashboard) and inbox / daily stats (GET /stats, /stats/daily). */
import type { Config } from './env';

export interface InboxStats {
	id: string;
	address: string;
	display_name: string | null;
	inbound: number;
	outbound: number;
	last_message_at: string | null;
}

export interface StatsJson {
	domains: string[];
	inboxes: InboxStats[];
	totals: { inboxes: number; inbound: number; outbound: number };
}

export interface DailyBucket {
	day: string;
	inbound: number;
	outbound: number;
}

export async function inboxStats(db: D1Database, config: Config): Promise<StatsJson> {
	const { results } = await db
		.prepare(
			`SELECT
				i.id,
				i.address,
				i.display_name,
				COALESCE(SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END), 0) AS inbound,
				COALESCE(SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END), 0) AS outbound,
				MAX(m.received_at) AS last_message_at
			FROM inboxes i
			LEFT JOIN messages m ON m.inbox_id = i.id
			GROUP BY i.id
			ORDER BY i.address ASC`,
		)
		.all<{
			id: string;
			address: string;
			display_name: string | null;
			inbound: number;
			outbound: number;
			last_message_at: number | null;
		}>();

	const inboxes: InboxStats[] = (results ?? []).map((r) => ({
		id: r.id,
		address: r.address,
		display_name: r.display_name,
		inbound: Number(r.inbound) || 0,
		outbound: Number(r.outbound) || 0,
		last_message_at: r.last_message_at == null ? null : new Date(r.last_message_at).toISOString(),
	}));
	return {
		domains: config.domains,
		inboxes,
		totals: {
			inboxes: inboxes.length,
			inbound: inboxes.reduce((n, i) => n + i.inbound, 0),
			outbound: inboxes.reduce((n, i) => n + i.outbound, 0),
		},
	};
}

export async function dailyStats(db: D1Database, days: number): Promise<{ days: number; buckets: DailyBucket[] }> {
	const n = Math.min(90, Math.max(1, Math.floor(days)));
	const since = Date.now() - n * 86400000;
	const { results } = await db
		.prepare(
			`SELECT
				strftime('%Y-%m-%d', received_at / 1000, 'unixepoch') AS day,
				SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
				SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
			FROM messages
			WHERE received_at >= ?
			GROUP BY day
			ORDER BY day ASC`,
		)
		.bind(since)
		.all<{ day: string; inbound: number; outbound: number }>();
	const byDay = new Map((results ?? []).map((r) => [r.day, { inbound: Number(r.inbound) || 0, outbound: Number(r.outbound) || 0 }]));
	const buckets: DailyBucket[] = [];
	for (let i = n - 1; i >= 0; i--) {
		const d = new Date(Date.now() - i * 86400000);
		const day = d.toISOString().slice(0, 10);
		const hit = byDay.get(day) ?? { inbound: 0, outbound: 0 };
		buckets.push({ day, ...hit });
	}
	return { days: n, buckets };
}

export function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
	};
}

export function dashboardSources(env: Env, requestUrl: string): string[] {
	const extra = String((env as { DASHBOARD_SOURCES?: string }).DASHBOARD_SOURCES ?? '')
		.split(',')
		.map((s) => s.trim().replace(/\/$/, ''))
		.filter(Boolean);
	const origin = new URL(requestUrl).origin;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const u of extra.length ? extra : [origin]) {
		if (seen.has(u)) continue;
		seen.add(u);
		out.push(u);
	}
	return out;
}

const ICON = {
	overview: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="10" y="2" width="6" height="6" rx="1"/><rect x="2" y="10" width="6" height="6" rx="1"/><rect x="10" y="10" width="6" height="6" rx="1"/></svg>',
	inboxes: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h12l-1 9H4L3 6z"/><path d="M3 6l6 5 6-5"/></svg>',
	metrics: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 14V8M8 14V4M13 14v-5"/></svg>',
	domains: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="9" r="7"/><path d="M2 9h14M9 2c2.5 2 3.5 5 3.5 7s-1 5-3.5 7c-2.5-2-3.5-5-3.5-7s1-5 3.5-7z"/></svg>',
	keys: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="9" r="3"/><path d="M10 9h6M14 9v3"/></svg>',
	collapse: '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 4L6 8l4 4"/></svg>',
};

export function renderDashboard(sources: string[]): string {
	return DASHBOARD_HTML.replace('__SOURCES__', JSON.stringify(sources));
}

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DearAgent</title>
<style>
  :root { color-scheme: dark; --bg:#050505; --side:#000; --panel:#0c0c0c; --line:#1c1c1c; --text:#f4f4f5; --muted:#737373; --sent:#3b82f6; --recv:#4ade80; --err:#f87171; --hover:#141414; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
  #app { display:flex; min-height:100%; }
  aside { width: 232px; background: var(--side); border-right: 1px solid var(--line); display:flex; flex-direction:column; flex-shrink:0; transition: width .15s ease; }
  aside.collapsed { width: 64px; }
  aside.collapsed .lbl, aside.collapsed .brand span, aside.collapsed .crumb { display:none; }
  .brand { display:flex; align-items:center; gap:.65rem; padding: 1rem .9rem; font-weight:600; letter-spacing:.02em; }
  .mark { width:28px; height:28px; border-radius:8px; background:#111; border:1px solid var(--line); display:grid; place-items:center; flex-shrink:0; }
  nav { display:flex; flex-direction:column; padding:.35rem .45rem; gap:2px; }
  nav button { display:flex; align-items:center; gap:.7rem; width:100%; background:transparent; border:0; color:var(--muted); padding:.65rem .7rem; border-radius:8px; cursor:pointer; text-align:left; font: inherit; }
  nav button svg { flex-shrink:0; opacity:.9; }
  nav button:hover { background: var(--hover); color: var(--text); }
  nav button.on { background: var(--hover); color: var(--text); }
  .grow { flex:1; }
  .collapse { margin:.45rem; background:transparent; border:1px solid var(--line); color:var(--muted); border-radius:8px; padding:.45rem; cursor:pointer; }
  main { flex:1; min-width:0; padding: 1.25rem 1.5rem 3rem; }
  .crumb { color: var(--muted); font-size:.8rem; margin-bottom: .85rem; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 1rem; }
  .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); border:1px solid var(--line); border-radius:10px; overflow:hidden; background: var(--panel); margin-bottom:1rem; }
  .stat { padding:1rem 1.1rem; border-right:1px solid var(--line); }
  .stat:last-child { border-right:0; }
  .stat b { display:block; font-size:1.6rem; font-weight:600; }
  .stat span { color:var(--muted); font-size:.8rem; display:flex; align-items:center; gap:.4rem; }
  .dot { width:8px; height:8px; border-radius:2px; }
  .chart { border:1px solid var(--line); border-radius:10px; background: var(--panel); padding:1rem 1rem .4rem; margin-bottom:1rem; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:.7rem .9rem; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-size:.72rem; font-weight:600; letter-spacing:.04em; text-transform:uppercase; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-flex; align-items:center; gap:.35rem; font-size:.8rem; color:#86efac; }
  .pill i { width:7px; height:7px; background:#4ade80; border-radius:1px; display:inline-block; }
  .sent { color: var(--sent); } .recv { color: var(--recv); }
  .err { color: var(--err); margin:.5rem 0 1rem; }
  form { display:grid; gap:.55rem; max-width:560px; }
  .row { display:flex; gap:.5rem; align-items:center; }
  .row label { min-width:6.5rem; color:var(--muted); }
  input { flex:1; background:#0a0a0a; border:1px solid var(--line); color:var(--text); border-radius:8px; padding:.55rem .75rem; }
  .go { background:#f4f4f5; color:#111; border:0; border-radius:8px; padding:.55rem .9rem; font-weight:600; cursor:pointer; justify-self:start; }
  .page { display:none; }
  .page.on { display:block; }
  .empty { color:var(--muted); padding:1.5rem; }
</style>
</head>
<body>
<div id="app">
  <aside id="side">
    <div class="brand"><div class="mark">DA</div><span>DearAgent</span></div>
    <nav>
      <button data-page="overview" class="on">` + ICON.overview + `<span class="lbl">Overview</span></button>
      <button data-page="inboxes">` + ICON.inboxes + `<span class="lbl">Inboxes</span></button>
      <button data-page="metrics">` + ICON.metrics + `<span class="lbl">Metrics</span></button>
      <button data-page="domains">` + ICON.domains + `<span class="lbl">Domains</span></button>
      <button data-page="keys">` + ICON.keys + `<span class="lbl">Keys</span></button>
    </nav>
    <div class="grow"></div>
    <button class="collapse" id="collapse" type="button" title="Collapse sidebar">` + ICON.collapse + `</button>
  </aside>
  <main>
    <div class="crumb" id="crumb">Dashboard · Overview</div>
    <p class="err" id="err" hidden></p>
    <section class="page on" id="page-overview">
      <div class="stats" id="ov-stats"></div>
      <div class="chart" id="ov-chart"></div>
    </section>
    <section class="page" id="page-inboxes"><table><thead><tr><th>Grain</th><th>Inbox</th><th>Received</th><th>Sent</th><th>Last message</th></tr></thead><tbody id="tb-inboxes"></tbody></table></section>
    <section class="page" id="page-metrics">
      <div class="stats" id="mx-stats"></div>
      <div class="chart" id="mx-chart"></div>
    </section>
    <section class="page" id="page-domains"><table><thead><tr><th>Domain</th><th>Grain</th><th>Status</th><th>Inboxes</th></tr></thead><tbody id="tb-domains"></tbody></table></section>
    <section class="page" id="page-keys">
      <h1>Keys</h1>
      <p class="crumb" style="margin-top:0">One Bearer token per Worker. Stored in this browser (localStorage) so new tabs keep them.</p>
      <form id="gate"></form>
    </section>
  </main>
</div>
<script>
const SOURCES = __SOURCES__;
const STORE = 'dearagent_keys';
const SIDE = 'dearagent_sidebar';
const err = document.getElementById('err');
let STATE = { stats: [], buckets: [] };
function grainName(url) {
  const h = new URL(url).hostname;
  const m = /^dearagent(?:-([a-z0-9]+))?\\./.exec(h);
  return (m && m[1]) ? m[1] : 'arnie';
}
function keys() {
  try {
    const local = JSON.parse(localStorage.getItem(STORE) || '{}');
    if (local && Object.keys(local).length) return local;
    const sess = JSON.parse(sessionStorage.getItem(STORE) || '{}');
    if (sess && Object.keys(sess).length) {
      localStorage.setItem(STORE, JSON.stringify(sess));
      return sess;
    }
    return {};
  } catch { return {}; }
}
function saveKeys(map) { localStorage.setItem(STORE, JSON.stringify(map)); }
function showErr(m) { err.hidden = !m; err.textContent = m || ''; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function drawGate() {
  const stored = keys();
  document.getElementById('gate').innerHTML = SOURCES.map((url, i) => {
    return '<div class="row"><label for="k' + i + '">' + escapeHtml(grainName(url)) + '</label>' +
      '<input id="k' + i + '" data-url="' + escapeHtml(url) + '" type="password" autocomplete="off" placeholder="API_KEY" value="' + escapeHtml(stored[url] || '') + '"></div>';
  }).join('') + '<button class="go" type="submit">Save keys</button>';
}
function drawChart(el, buckets, title) {
  const w = 920, h = 220, padL = 36, padR = 12, padT = 12, padB = 28;
  const n = buckets.length || 1;
  const slot = (w - padL - padR) / n;
  const bar = Math.max(2, (slot - 3) / 2);
  let max = 1;
  for (const b of buckets) max = Math.max(max, b.inbound, b.outbound);
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const y = padT + ((h - padT - padB) * g) / 4;
    grid += '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + y + '" y2="' + y + '" stroke="#1c1c1c"/>';
  }
  let bars = '';
  buckets.forEach((b, i) => {
    const x = padL + i * slot;
    const plot = h - padT - padB;
    const inH = (b.inbound / max) * plot;
    const outH = (b.outbound / max) * plot;
    bars += '<rect x="' + x + '" y="' + (h - padB - outH) + '" width="' + bar + '" height="' + outH + '" fill="#3b82f6" rx="1"/>';
    bars += '<rect x="' + (x + bar + 1) + '" y="' + (h - padB - inH) + '" width="' + bar + '" height="' + inH + '" fill="#4ade80" rx="1"/>';
  });
  const ticks = [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1];
  let labels = '';
  for (const i of ticks) {
    const b = buckets[i]; if (!b) continue;
    const x = padL + i * slot;
    const t = b.day.slice(5);
    labels += '<text x="' + x + '" y="' + (h - 8) + '" fill="#737373" font-size="11">' + escapeHtml(t) + '</text>';
  }
  el.innerHTML = '<div style="color:#737373;font-size:.78rem;margin:0 0 .5rem">' + escapeHtml(title) +
    ' · <span style="color:#3b82f6">■ sent</span> · <span style="color:#4ade80">■ received</span></div>' +
    '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="240">' + grid + bars + labels + '</svg>';
}
function statBox(n, label, color) {
  return '<div class="stat"><span><i class="dot" style="background:' + color + '"></i>' + label + '</span><b>' + n + '</b></div>';
}
function render() {
  const stats = STATE.stats;
  const buckets = STATE.buckets;
  let sent = 0, recv = 0, n = 0;
  const ib = document.getElementById('tb-inboxes');
  ib.innerHTML = '';
  const domainMap = new Map();
  for (const s of stats) {
    for (const d of s.data.domains || []) {
      const cur = domainMap.get(d) || { domain: d, grain: s.grain, n: 0 };
      domainMap.set(d, cur);
    }
    for (const i of s.data.inboxes || []) {
      n++; sent += i.outbound; recv += i.inbound;
      const last = i.last_message_at ? new Date(i.last_message_at).toISOString().replace('T',' ').slice(0,16)+'Z' : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + escapeHtml(s.grain) + '</td><td>' +
        escapeHtml(i.display_name ? i.display_name + ' · ' + i.address : i.address) +
        '</td><td class="recv">' + i.inbound + '</td><td class="sent">' + i.outbound + '</td><td>' + last + '</td>';
      ib.appendChild(tr);
      const dom = (i.address.split('@')[1] || '').toLowerCase();
      if (dom) {
        const cur = domainMap.get(dom) || { domain: dom, grain: s.grain, n: 0 };
        cur.n++; domainMap.set(dom, cur);
      }
    }
  }
  document.getElementById('ov-stats').innerHTML =
    statBox(sent, 'Messages sent', '#3b82f6') + statBox(recv, 'Messages received', '#4ade80') +
    statBox(n, 'Inboxes', '#a1a1aa') + statBox(stats.length, 'Workers', '#a1a1aa');
  document.getElementById('mx-stats').innerHTML =
    statBox(sent, 'Sent', '#3b82f6') + statBox(recv, 'Received', '#4ade80');
  const last14 = buckets.slice(-14);
  drawChart(document.getElementById('ov-chart'), last14, 'Last 14 days');
  drawChart(document.getElementById('mx-chart'), buckets, 'Last 30 days');
  const db = document.getElementById('tb-domains');
  db.innerHTML = '';
  for (const d of [...domainMap.values()].sort((a,b) => a.domain.localeCompare(b.domain))) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(d.domain) + '</td><td>' + escapeHtml(d.grain) +
      '</td><td><span class="pill"><i></i>Verified</span></td><td>' + d.n + '</td>';
    db.appendChild(tr);
  }
}
function showPage(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === 'page-' + id));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === id));
  const names = { overview:'Overview', inboxes:'Inboxes', metrics:'Metrics', domains:'Domains', keys:'Keys' };
  document.getElementById('crumb').textContent = 'Dashboard · ' + (names[id] || id);
}
async function load() {
  const stored = keys();
  const missing = SOURCES.filter((u) => !stored[u]);
  drawGate();
  if (missing.length) { showPage('keys'); showErr('Paste each Worker API_KEY, then Save keys.'); return; }
  showErr('');
  const stats = [];
  const days = [];
  const problems = [];
  for (const url of SOURCES) {
    const hdr = { Authorization: 'Bearer ' + stored[url] };
    const [sRes, dRes] = await Promise.all([
      fetch(url + '/stats', { headers: hdr }),
      fetch(url + '/stats/daily?days=30', { headers: hdr }),
    ]);
    if (sRes.status === 401 || dRes.status === 401) {
      delete stored[url]; saveKeys(stored);
      problems.push(grainName(url) + ': bad key');
      continue;
    }
    if (!sRes.ok || !dRes.ok) { problems.push(grainName(url) + ': HTTP ' + sRes.status); continue; }
    stats.push({ grain: grainName(url), url, data: await sRes.json() });
    days.push(await dRes.json());
  }
  if (!stats.length) { showPage('keys'); showErr(problems.join(' · ') || 'No workers loaded'); return; }
  showErr(problems.join(' · '));
  const merged = new Map();
  for (const d of days) {
    for (const b of d.buckets || []) {
      const cur = merged.get(b.day) || { day: b.day, inbound: 0, outbound: 0 };
      cur.inbound += b.inbound; cur.outbound += b.outbound;
      merged.set(b.day, cur);
    }
  }
  STATE = { stats, buckets: [...merged.values()].sort((a,b) => a.day.localeCompare(b.day)) };
  render();
  if (document.querySelector('nav button.on').dataset.page === 'keys' && !missing.length) showPage('overview');
}
document.getElementById('gate').addEventListener('submit', (e) => {
  e.preventDefault();
  const map = {};
  for (const input of document.querySelectorAll('#gate input[data-url]')) {
    const k = input.value.trim();
    if (k) map[input.dataset.url] = k;
  }
  saveKeys(map);
  load();
});
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
const side = document.getElementById('side');
if (localStorage.getItem(SIDE) === '1') side.classList.add('collapsed');
document.getElementById('collapse').addEventListener('click', () => {
  side.classList.toggle('collapsed');
  localStorage.setItem(SIDE, side.classList.contains('collapsed') ? '1' : '0');
});
drawGate();
load();
</script>
</body>
</html>
`;
