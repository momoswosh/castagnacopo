/**
 * Castagnacopo – backend su Cloudflare Workers + D1
 * Stesse funzioni del vecchio Code.gs (Google Apps Script), stesse risposte JSON.
 *
 * GET  /api?action=info | report&key=… | mine&t=… | prep&t=…
 * POST /api  (corpo JSON in text/plain) – ordine nuovo oppure { action: … }
 *
 * La password del report non è nel codice: nel database c'è solo la sua impronta (settings.report_key_sha256).
 * Avvisi: notifiche push con ntfy (https://ntfy.sh), canale in settings.ntfy_topic (vedi notify()).
 */

const TZ = 'Europe/Rome';
const SIZES = [1, 3, 5, 10];
const DEFAULT_COSTS = [6.5, 16.5, 24, 52];
const DEFAULT_MSG = 'Le prenotazioni sono chiuse. Se ci sarà nuova disponibilità vi avviseremo. Grazie!';
const SITE = 'https://castagnacopo.boneggio.it';

const round2 = n => Math.round(n * 100) / 100;
const num_ = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) && n >= 0 ? round2(n) : 0; };
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const isYear = y => /^\d{4}$/.test(String(y || ''));

function nowParts() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { year: p.year, date: `${p.year}-${p.month}-${p.day}`, stamp: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` };
}
const thisYear = () => nowParts().year;
const newToken = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'ref';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });

/* ---------- impostazioni ---------- */

async function getProps(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map(r => [r.key, r.value]));
}
async function setProp(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}

function settingsFrom(p) {
  const s = { open: p.open !== '0', limit: p.limit ? Number(p.limit) : 0, msg: p.msg || '', deadline: p.deadline || '',
    markup: num_(p.markup), quota: num_(p.quota), ritiro: p.ritiro || '' };
  let costs = DEFAULT_COSTS;
  try { const c = JSON.parse(p.costs || 'null'); if (c && c.length === SIZES.length) costs = c.map(num_); } catch (e) {}
  s.costs = costs;
  let sale = SIZES.map(() => '');
  try { const v = JSON.parse(p.sale || 'null'); if (v && v.length === SIZES.length) sale = v.map(x => x === '' || x == null ? '' : num_(x)); } catch (e) {}
  s.sale = sale;
  s.prices = SIZES.map((z, i) => sale[i] !== '' && sale[i] > 0 ? sale[i] : round2(costs[i] + s.markup * z));
  const today = nowParts().date;
  s.expired = !!s.deadline && today > s.deadline;
  s.active = s.open && !s.expired;
  return s;
}
const settings = async env => settingsFrom(await getProps(env));

/* ---------- referenti e preparatori ---------- */

async function referenti(env, def) {
  if (def == null) def = (await settings(env)).quota;
  const { results } = await env.DB.prepare('SELECT code, nome, wa, tk, quota FROM referenti ORDER BY pos, rowid').all();
  return results.map(r => {
    const own = r.quota == null ? '' : num_(r.quota);
    return { code: r.code, nome: r.nome, wa: r.wa, tk: r.tk, quota: own, rate: own === '' ? def : own };
  });
}
async function preparatori(env) {
  const { results } = await env.DB.prepare('SELECT code, nome, tk FROM preparatori ORDER BY pos, rowid').all();
  return results;
}
async function refByToken(env, tk) {
  tk = String(tk || '');
  if (tk.length < 10) return null;
  return (await referenti(env)).find(r => r.tk === tk) || null;
}
async function prepByToken(env, tk) {
  tk = String(tk || '');
  if (tk.length < 10) return null;
  return env.DB.prepare('SELECT code, nome, tk FROM preparatori WHERE tk = ?1').bind(tk).first();
}

/* ---------- ordini ---------- */

const toOrder = r => ({
  id: r.id, data: r.data, nome: r.nome, cognome: r.cognome, telefono: r.telefono, ref: r.ref, contatto: r.contatto,
  q1: r.q1, q3: r.q3, q5: r.q5, q10: r.q10, kg: r.kg, euro: r.euro, note: r.note,
  pagato: !!r.pagato, consegnato: !!r.consegnato, costo: r.costo, ricarico: r.ricarico,
  r1: r.r1, r3: r.r3, r5: r.r5, r10: r.r10, prontoDal: r.pronto_dal, prepBy: r.prep_by
});
async function readOrders(env, year) {
  const { results } = await env.DB.prepare('SELECT * FROM ordini WHERE anno = ?1 ORDER BY pos, rowid').bind(String(year)).all();
  return results.map(toOrder);
}
function ordersOfRef(orders, ref) {
  const nm = ref.nome.trim().toLowerCase();
  return orders.filter(o => o.ref === ref.code || (!o.ref && String(o.contatto).trim().toLowerCase() === nm));
}
async function kgOrdered(env, year) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(kg), 0) AS kg FROM ordini WHERE anno = ?1').bind(String(year)).first();
  return +r.kg || 0;
}
async function years(env) {
  const { results } = await env.DB.prepare('SELECT DISTINCT anno FROM ordini').all();
  const ys = results.map(r => r.anno).filter(isYear);
  const y = thisYear();
  if (!ys.includes(y)) ys.push(y);
  return ys.sort().reverse();
}

/* ---------- notifiche (ntfy) ---------- */

// Avvisi sul telefono con l'app ntfy: il canale (topic) è nelle impostazioni, chiave "ntfy_topic".
function notify(env, ctx, subject, body) {
  ctx.waitUntil((async () => {
    const topic = (await getProps(env)).ntfy_topic;
    if (!topic) return;
    await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title: subject, message: body, tags: ['chestnut'], click: SITE + '/report.html' }) });
  })().catch(() => {}));
}
const eurTxt = n => n.toFixed(2).replace('.', ',') + ' €';

/* ---------- GET ---------- */

async function info(env) {
  const s = await settings(env);
  const out = { ok: true, open: s.active, msg: s.msg || DEFAULT_MSG, deadline: s.deadline, prices: s.prices, ritiro: s.ritiro,
    referenti: (await referenti(env, s.quota)).map(r => ({ code: r.code, nome: r.nome })) };
  if (s.limit > 0) out.left = Math.max(0, s.limit - await kgOrdered(env, thisYear()));
  return out;
}

async function checkKey(env, key) {
  const p = await getProps(env);
  return !!p.report_key_sha256 && (await sha256(String(key || ''))) === p.report_key_sha256;
}

async function report(env, p) {
  const anno = isYear(p.anno) ? p.anno : thisYear();
  const s = await settings(env);
  return { ok: true, anno, anni: await years(env), orders: await readOrders(env, anno),
    referenti: await referenti(env, s.quota), preparatori: await preparatori(env), settings: s, kgYear: await kgOrdered(env, thisYear()) };
}

async function mine(env, tk, anno) {
  const ref = await refByToken(env, tk);
  if (!ref) return { ok: false, error: 'Link non valido. Chiedi un nuovo link a chi organizza.' };
  const year = isYear(anno) ? anno : thisYear();
  const orders = ordersOfRef(await readOrders(env, year), ref)
    .map(o => ({ id: o.id, nome: o.nome, cognome: o.cognome, telefono: o.telefono, q1: o.q1, q3: o.q3, q5: o.q5, q10: o.q10,
      kg: o.kg, euro: o.euro, note: o.note, pagato: o.pagato, consegnato: o.consegnato, data: o.data,
      r1: o.r1, r3: o.r3, r5: o.r5, r10: o.r10, prontoDal: o.prontoDal }));
  return { ok: true, nome: ref.nome, anno: year, anni: await years(env), orders, rate: ref.rate };
}

async function prep(env, tk, anno) {
  const pr = await prepByToken(env, tk);
  if (!pr) return { ok: false, error: 'Link non valido. Chiedi un nuovo link a chi organizza.' };
  const year = isYear(anno) ? anno : thisYear();
  const orders = (await readOrders(env, year)).map(o => ({ id: o.id, nome: o.nome, cognome: o.cognome, contatto: o.contatto, data: o.data,
    q1: o.q1, q3: o.q3, q5: o.q5, q10: o.q10, r1: o.r1, r3: o.r3, r5: o.r5, r10: o.r10, kg: o.kg,
    prontoDal: o.prontoDal, prepBy: o.prepBy, consegnato: o.consegnato }));
  return { ok: true, nome: pr.nome, anno: year, anni: await years(env), orders };
}

/* ---------- POST ---------- */

async function order(env, ctx, d) {
  // stessa richiesta inviata due volte (es. riprova dopo un errore di rete): restituisce l'esito già salvato
  const rid = d.rid ? String(d.rid).slice(0, 64) : '';
  if (rid) {
    const prev = await env.DB.prepare('SELECT res FROM rids WHERE rid = ?1').bind(rid).first();
    if (prev) return JSON.parse(prev.res);
  }
  const s = await settings(env);
  if (!s.active) return { ok: false, closed: true, error: s.msg || DEFAULT_MSG };

  const nome = clean(d.nome, 60), cognome = clean(d.cognome, 60);
  if (!nome || !cognome) return { ok: false, error: 'Nome e cognome obbligatori' };

  let ref = '', contatto = clean(d.contatto, 60);
  if (d.ref) {
    const r = (await referenti(env, s.quota)).find(x => x.code === String(d.ref));
    if (r) { ref = r.code; contatto = r.nome; }
  }
  if (!contatto) return { ok: false, error: 'Contatto obbligatorio' };

  const qty = SIZES.map(z => Math.max(0, Math.min(99, parseInt(d['q' + z], 10) || 0)));
  const kg = qty.reduce((t, q, i) => t + q * SIZES[i], 0);
  const euro = round2(qty.reduce((t, q, i) => t + q * s.prices[i], 0));
  const costo = round2(qty.reduce((t, q, i) => t + q * s.costs[i], 0));
  const ricarico = round2(euro - costo);
  if (kg === 0) return { ok: false, error: 'Nessun sacco selezionato' };

  const now = nowParts();
  if (s.limit > 0) {
    const left = s.limit - await kgOrdered(env, now.year);
    if (kg > left) return { ok: false, error: left > 0 ? 'Sono rimasti solo ' + left + ' kg disponibili.' : 'Le castagne disponibili sono finite.' };
  }

  const id = 'o' + crypto.randomUUID().slice(0, 8);
  const telefono = clean(d.telefono, 30), note = clean(d.note, 500);
  const res = { ok: true, kg, euro, ritiro: s.ritiro };
  const stmts = [env.DB.prepare(`INSERT INTO ordini (id, anno, data, nome, cognome, telefono, ref, contatto, q1, q3, q5, q10, kg, euro, note, costo, ricarico, pos)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, (SELECT COALESCE(MAX(pos), 0) + 1 FROM ordini))`)
    .bind(id, now.year, now.stamp, nome, cognome, telefono, ref, contatto, qty[0], qty[1], qty[2], qty[3], kg, euro, note, costo, ricarico)];
  if (rid) {
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO rids (rid, res, ts) VALUES (?1, ?2, ?3)').bind(rid, JSON.stringify(res), Date.now()));
    stmts.push(env.DB.prepare('DELETE FROM rids WHERE ts < ?1').bind(Date.now() - 86400000));
  }
  await env.DB.batch(stmts);

  const sacchi = SIZES.map((z, i) => qty[i] ? qty[i] + ' × ' + z + ' kg' : '').filter(Boolean).join(', ');
  notify(env, ctx, 'Castagnacopo: ' + nome + ' ' + cognome + ' – ' + kg + ' kg',
    'Nome: ' + nome + ' ' + cognome + '\n' + (telefono ? 'Telefono: ' + telefono + '\n' : '') +
    'Contatto: ' + contatto + '\nSacchi: ' + sacchi + '\nTotale: ' + kg + ' kg – ' + eurTxt(euro) + '\n' +
    (note ? 'Note: ' + note : ''));
  return res;
}

async function remove(env, d) {
  const anno = String(d.anno);
  if (d.all === true) {
    const r = await env.DB.prepare('DELETE FROM ordini WHERE anno = ?1').bind(anno).run();
    return { ok: true, deleted: r.meta.changes || 0 };
  }
  const ids = (d.ids || []).map(String);
  if (!ids.length) return { ok: true, deleted: 0 };
  const rs = await env.DB.batch(ids.map(id => env.DB.prepare('DELETE FROM ordini WHERE anno = ?1 AND id = ?2').bind(anno, id)));
  return { ok: true, deleted: rs.reduce((t, r) => t + (r.meta.changes || 0), 0) };
}

async function flag(env, d) {
  const col = d.field === 'pagato' ? 'pagato' : d.field === 'consegnato' ? 'consegnato' : '';
  if (!col) return { ok: false, error: 'Campo non valido' };
  const ids = (d.ids || []).map(String);
  if (!ids.length) return { ok: true, updated: 0 };
  const v = d.value === true ? 1 : 0;
  const rs = await env.DB.batch(ids.map(id => env.DB.prepare(`UPDATE ordini SET ${col} = ?1 WHERE anno = ?2 AND id = ?3`).bind(v, String(d.anno), id)));
  return { ok: true, updated: rs.reduce((t, r) => t + (r.meta.changes || 0), 0) };
}

async function mineFlag(env, d) {
  const ref = await refByToken(env, d.t);
  if (!ref) return { ok: false, error: 'Link non valido' };
  const year = isYear(d.anno) ? String(d.anno) : thisYear();
  const allowed = ordersOfRef(await readOrders(env, year), ref).map(o => o.id);
  const ids = (d.ids || []).map(String).filter(id => allowed.includes(id));
  return flag(env, { anno: year, ids, field: d.field, value: d.value });
}

async function mineDelete(env, ctx, d) {
  const ref = await refByToken(env, d.t);
  if (!ref) return { ok: false, error: 'Link non valido' };
  const year = isYear(d.anno) ? String(d.anno) : thisYear();
  const want = (d.ids || []).map(String);
  const asked = ordersOfRef(await readOrders(env, year), ref).filter(o => want.includes(o.id));
  if (!asked.length) return { ok: false, error: 'Ordine non trovato' };
  const gone = asked.filter(o => !(o.pagato && o.consegnato));
  if (!gone.length) return { ok: false, error: 'Ordine già pagato e consegnato: non si può annullare' };
  const res = await remove(env, { anno: year, ids: gone.map(o => o.id) });
  notify(env, ctx, 'Castagnacopo: ordine annullato da ' + ref.nome,
    ref.nome + ' ha annullato:\n\n' + gone.map(o => '- ' + o.nome + ' ' + o.cognome + ': ' + o.kg + ' kg, ' + eurTxt(o.euro)).join('\n') +
    '');
  return res;
}

async function prepSet(env, d) {
  const pr = await prepByToken(env, d.t);
  if (!pr) return { ok: false, error: 'Link non valido' };
  const year = isYear(d.anno) ? String(d.anno) : thisYear();
  const row = await env.DB.prepare('SELECT q1, q3, q5, q10, pronto_dal FROM ordini WHERE anno = ?1 AND id = ?2').bind(year, String(d.id)).first();
  if (!row) return { ok: false, error: 'Ordine non trovato (forse è stato annullato)' };
  const q = [row.q1, row.q3, row.q5, row.q10];
  const r = SIZES.map((z, k) => Math.max(0, Math.min(q[k], parseInt((d.r || {})[z], 10) || 0)));
  // data di ritiro: la decide il preparatore ('aaaa-mm-gg' oppure '' per toglierla); se non la manda resta quella di prima
  const dal = ('dal' in d) ? (/^\d{4}-\d{2}-\d{2}$/.test(String(d.dal)) ? String(d.dal) : '') : row.pronto_dal;
  await env.DB.prepare('UPDATE ordini SET r1 = ?1, r3 = ?2, r5 = ?3, r10 = ?4, pronto_dal = ?5, prep_by = ?6 WHERE anno = ?7 AND id = ?8')
    .bind(r[0], r[1], r[2], r[3], dal, r.some(x => x > 0) ? pr.nome : '', year, String(d.id)).run();
  return { ok: true, id: String(d.id), r1: r[0], r3: r[1], r5: r[2], r10: r[3], prontoDal: dal };
}

async function saveSettings(env, d) {
  const p = await getProps(env);
  const set = (k, v) => setProp(env, k, v);
  if ('open' in d) await set('open', d.open ? '1' : '0');
  if ('limit' in d) await set('limit', String(Math.max(0, parseInt(d.limit, 10) || 0)));
  if ('addKg' in d) await set('limit', String(Math.max(0, (Number(p.limit || 0) || 0) + (parseInt(d.addKg, 10) || 0))));
  if ('msg' in d) await set('msg', clean(d.msg, 300));
  if ('ritiro' in d) await set('ritiro', clean(d.ritiro, 300));
  if ('markup' in d) await set('markup', String(num_(d.markup)));
  if ('quota' in d) await set('quota', String(num_(d.quota)));
  if ('costs' in d) {
    const c = (d.costs || []).map(num_);
    if (c.length !== SIZES.length || c.some(x => !(x > 0))) return { ok: false, error: 'Prezzi del produttore non validi' };
    await set('costs', JSON.stringify(c));
  }
  if ('sale' in d) {
    const v = (d.sale || []).map(x => String(x == null ? '' : x).trim() === '' ? '' : num_(x));
    if (v.length !== SIZES.length || v.some(x => x !== '' && !(x > 0))) return { ok: false, error: 'Prezzi di vendita non validi' };
    await set('sale', JSON.stringify(v));
  }
  if ('deadline' in d) await set('deadline', /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline)) ? String(d.deadline) : '');
  return { ok: true, settings: await settings(env) };
}

async function refSave(env, d) {
  const nome = clean(d.nome, 60);
  const wa = String(d.wa || '').replace(/[^\d+]/g, '').slice(0, 20);
  if (!nome) return { ok: false, error: 'Nome obbligatorio' };
  const quota = String(d.quota == null ? '' : d.quota).trim() === '' ? null : num_(d.quota);
  const list = await referenti(env);
  if (d.code) {
    if (!list.some(r => r.code === String(d.code))) return { ok: false, error: 'Referente non trovato' };
    await env.DB.prepare('UPDATE referenti SET nome = ?1, wa = ?2, quota = ?3 WHERE code = ?4').bind(nome, wa, quota, String(d.code)).run();
    return { ok: true, referenti: await referenti(env) };
  }
  let code = slug(nome), k = 2;
  while (list.some(r => r.code === code)) code = slug(nome) + k++;
  await env.DB.prepare('INSERT INTO referenti (code, nome, wa, tk, quota, pos) VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(pos), 0) + 1 FROM referenti))')
    .bind(code, nome, wa, newToken(), quota).run();
  // collega al nuovo referente gli ordini dove il contatto era stato scritto a mano con lo stesso nome
  let linked = 0;
  const adopt = String(d.adopt || '').trim().toLowerCase();
  if (adopt) {
    const year = isYear(d.anno) ? String(d.anno) : thisYear();
    const r = await env.DB.prepare("UPDATE ordini SET ref = ?1, contatto = ?2 WHERE anno = ?3 AND ref = '' AND lower(trim(contatto)) = ?4")
      .bind(code, nome, year, adopt).run();
    linked = r.meta.changes || 0;
  }
  return { ok: true, code, linked, referenti: await referenti(env) };
}

async function refDelete(env, d) {
  await env.DB.prepare('DELETE FROM referenti WHERE code = ?1').bind(String(d.code)).run();
  return { ok: true, referenti: await referenti(env) };
}

async function prepSave(env, d) {
  const nome = clean(d.nome, 60);
  if (!nome) return { ok: false, error: 'Nome obbligatorio' };
  const list = await preparatori(env);
  if (d.code) {
    if (!list.some(p => p.code === String(d.code))) return { ok: false, error: 'Preparatore non trovato' };
    await env.DB.prepare('UPDATE preparatori SET nome = ?1 WHERE code = ?2').bind(nome, String(d.code)).run();
  } else {
    let code = slug(nome), k = 2;
    while (list.some(p => p.code === code)) code = slug(nome) + k++;
    await env.DB.prepare('INSERT INTO preparatori (code, nome, tk, pos) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(pos), 0) + 1 FROM preparatori))')
      .bind(code, nome, newToken()).run();
  }
  return { ok: true, preparatori: await preparatori(env) };
}

async function prepDelete(env, d) {
  await env.DB.prepare('DELETE FROM preparatori WHERE code = ?1').bind(String(d.code)).run();
  return { ok: true, preparatori: await preparatori(env) };
}

/* ---------- smistamento ---------- */

async function handleGet(env, url) {
  const p = Object.fromEntries(url.searchParams);
  if (p.action === 'info') return info(env);
  if (p.action === 'mine') return mine(env, p.t, p.anno);
  if (p.action === 'prep') return prep(env, p.t, p.anno);
  if (p.action !== 'report') return { ok: true, service: 'castagnacopo' };
  if (!await checkKey(env, p.key)) return { ok: false, error: 'Password errata' };
  return report(env, p);
}

async function handlePost(env, ctx, request) {
  let d;
  try { d = JSON.parse(await request.text() || '{}'); } catch (e) { return { ok: false, error: 'Richiesta non valida' }; }
  if (d.action === 'mineFlag') return mineFlag(env, d);
  if (d.action === 'mineDelete') return mineDelete(env, ctx, d);
  if (d.action === 'prepSet') return prepSet(env, d);
  if (d.action) {
    if (!await checkKey(env, d.key)) return { ok: false, error: 'Password errata' };
    if (d.action === 'delete') return remove(env, d);
    if (d.action === 'flag') return flag(env, d);
    if (d.action === 'settings') return saveSettings(env, d);
    if (d.action === 'refSave') return refSave(env, d);
    if (d.action === 'refDelete') return refDelete(env, d);
    if (d.action === 'prepSave') return prepSave(env, d);
    if (d.action === 'prepDelete') return prepDelete(env, d);
    return { ok: false, error: 'Azione sconosciuta' };
  }
  return order(env, ctx, d);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname !== '/' && url.pathname !== '/api') return json({ ok: false, error: 'Non trovato' }, 404);
    try {
      if (request.method === 'GET') return json(await handleGet(env, url));
      if (request.method === 'POST') return json(await handlePost(env, ctx, request));
      return json({ ok: false, error: 'Metodo non permesso' }, 405);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) });
    }
  }
};
