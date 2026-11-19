// =====================================================================
//  PANEL DE STAFF · aprobaciones, clientes y control de ingreso
// =====================================================================
import { CONFIG } from './config.js';
import { api, humanError } from './api.js';
import { $, $$, esc, money, onlyDigits, toast, formatDateTime, timeAgo, whatsappLink } from './common.js';

const CACHE_KEY = 'xmas_door_cache_v1';
const QUEUE_KEY = 'xmas_door_queue_v1';

const state = {
  session: null,
  orders: [],
  tiers: [],
  tab: 'door',
  justApproved: new Map(), // id -> order (para mostrar el botón de WhatsApp)
  scanner: null,
  lastScan: { code: '', at: 0 },
  online: navigator.onLine,
};

const isAdmin = () => state.session?.role === 'admin';
const tierName = (id) => state.tiers.find((t) => t.id === id)?.name || `Tanda ${id}`;
const effStatus = (o) => (o.status === 'pending' && new Date(o.expires_at) <= new Date() ? 'expired' : o.status);
const STATUS_LABEL = { approved: 'Aprobada', pending: 'Pendiente', expired: 'Vencida', rejected: 'Rechazada', cancelled: 'Cancelada' };

// ---------------------------------------------------------------------
//  Sonido + vibración para la puerta
// ---------------------------------------------------------------------
let audioCtx;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'ok' ? [[880, 0], [1320, 0.09]] : kind === 'warn' ? [[520, 0], [520, 0.18]] : [[160, 0]];
    notes.forEach(([f, t]) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = kind === 'error' ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.25, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + (kind === 'error' ? 0.45 : 0.15));
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t);
      o.stop(audioCtx.currentTime + t + 0.5);
    });
  } catch { /* noop */ }
  navigator.vibrate?.(kind === 'ok' ? 80 : [120, 80, 120]);
}

// ---------------------------------------------------------------------
//  Sesión
// ---------------------------------------------------------------------
async function init() {
  bindEvents();
  updateNet();
  state.session = await api.getSession().catch(() => null);
  if (state.session?.role) showApp();
  else showLogin(state.session && !state.session.role ? 'Tu usuario no tiene permisos de staff.' : '');
}

function showLogin(msg = '') {
  $('#view-app').hidden = true;
  $('#view-login').hidden = false;
  $('#login-error').textContent = msg;
  if (api.mode === 'demo') $('#login-error').textContent = 'Modo demo: cualquier email/clave. Usá "puerta@..." para ver el rol de puerta.';
}

async function onLogin(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#login-error').textContent = '';
  try {
    state.session = await api.signIn(f.email.value.trim(), f.password.value);
    if (!state.session?.role) {
      await api.signOut();
      throw new Error('NO_AUTORIZADO');
    }
    f.reset();
    showApp();
  } catch (err) {
    $('#login-error').textContent = /Invalid login/i.test(err?.message) ? 'Email o contraseña incorrectos.' : humanError(err);
  } finally {
    btn.disabled = false;
  }
}

let unsubscribe = null;
let refreshTimer = null;
async function showApp() {
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
  $('#st-user').textContent = `${state.session.name} · ${isAdmin() ? 'Administrador' : 'Puerta'}`;
  $$('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });

  loadCache();
  renderAll();
  await refresh();
  unsubscribe = api.subscribe(debounce(refresh, 800));
  refreshTimer = setInterval(refresh, 30000);
  syncQueue();
}

async function logout() {
  stopScanner();
  unsubscribe?.();
  clearInterval(refreshTimer);
  await api.signOut();
  state.session = null;
  showLogin();
}

// ---------------------------------------------------------------------
//  Datos
// ---------------------------------------------------------------------
async function refresh() {
  try {
    const [orders, tiers] = await Promise.all([api.listOrders(), state.tiers.length ? state.tiers : api.listTiers()]);
    state.orders = orders;
    state.tiers = tiers;
    saveCache();
    renderAll();
  } catch (err) {
    console.warn('refresh', err);
  }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), orders: state.orders, tiers: state.tiers }));
  } catch { /* noop */ }
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c) { state.orders = c.orders || []; state.tiers = c.tiers || []; }
  } catch { /* noop */ }
}
const getQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } };
const setQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* noop */ } };

function allTickets() {
  return state.orders.flatMap((o) => (o.tickets || []).map((t) => ({ ...t, order: o })));
}

function renderAll() {
  renderDoorStats();
  renderRecent();
  if (isAdmin()) {
    renderPending();
    renderOrders();
    renderSummary();
  }
}

// ---------------------------------------------------------------------
//  Tabs
// ---------------------------------------------------------------------
function switchTab(tab) {
  state.tab = tab;
  $$('.st-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.st-view').forEach((v) => { v.hidden = v.id !== `tab-${tab}`; });
  if (tab !== 'door') stopScanner();
}

// ---------------------------------------------------------------------
//  PUERTA
// ---------------------------------------------------------------------
function renderDoorStats() {
  const tickets = allTickets().filter((t) => t.order.status === 'approved');
  $('#door-in').textContent = tickets.filter((t) => t.used_at).length;
  $('#door-total').textContent = tickets.length;
  $('#door-queue').textContent = getQueue().length;
}

function renderRecent() {
  const recent = allTickets().filter((t) => t.used_at).sort((a, b) => new Date(b.used_at) - new Date(a.used_at)).slice(0, 15);
  $('#door-recent').innerHTML = recent.length
    ? recent.map((t) => `<div class="row"><div><b>${esc(t.holder_name)}</b><small>DNI ${esc(t.holder_dni)} · ${esc(tierName(t.tier_id))}</small></div><small>${timeAgo(t.used_at)}</small></div>`).join('')
    : '<p class="muted">Todavía no ingresó nadie.</p>';
}

async function doCheckIn({ code, ticketId }) {
  try {
    const res = await api.checkIn({ code, ticketId });
    // reflejar en memoria para no esperar el refresh
    if (res.result === 'ok') {
      const t = allTickets().find((x) => x.id === res.ticket_id);
      if (t) {
        const real = t.order.tickets.find((x) => x.id === t.id);
        real.used_at = new Date().toISOString();
      }
      saveCache();
    }
    return res;
  } catch (err) {
    if (!/Failed to fetch|NetworkError|network/i.test(err?.message || '')) throw err;
    return offlineCheckIn({ code, ticketId });
  }
}

/** Sin internet: valida contra la copia local y deja el ingreso en cola. */
function offlineCheckIn({ code, ticketId }) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = allTickets().find((x) => (ticketId ? x.id === ticketId : x.code === c));
  if (!t) return { result: 'not_found', offline: true };
  const base = { ticket_id: t.id, code: t.code, holder_name: t.holder_name, holder_dni: t.holder_dni, tier: tierName(t.tier_id), offline: true };
  if (t.order.status !== 'approved') return { ...base, result: 'not_approved', status: effStatus(t.order) };
  const real = t.order.tickets.find((x) => x.id === t.id);
  if (real.used_at) return { ...base, result: 'used', used_at: real.used_at };
  real.used_at = new Date().toISOString();
  setQueue([...getQueue(), { ticketId: t.id, at: real.used_at }]);
  saveCache();
  return { ...base, result: 'ok' };
}

async function syncQueue() {
  const q = getQueue();
  if (!q.length || !navigator.onLine) return;
  const rest = [];
  for (const item of q) {
    try { await api.checkIn({ ticketId: item.ticketId }); } catch { rest.push(item); }
  }
  setQueue(rest);
  if (q.length !== rest.length) toast(`Sincronizados ${q.length - rest.length} ingresos offline`, 'success');
  renderDoorStats();
  refresh();
}

function showScanResult(res) {
  const el = $('#scan-result');
  const kind = res.result === 'ok' ? 'ok' : res.result === 'used' ? 'warn' : 'error';
  const title = {
    ok: '✅ ADELANTE',
    used: '⚠️ YA INGRESÓ',
    not_found: '❌ QR NO VÁLIDO',
    not_approved: '⛔ NO HABILITADA',
  }[res.result] || '❌ ERROR';
  const detail = res.result === 'used'
    ? `Ingresó ${formatDateTime(res.used_at)}`
    : res.result === 'not_approved' ? `Orden ${STATUS_LABEL[res.status] || res.status}` : '';
  el.className = `scan-result is-${kind}`;
  el.innerHTML = `
    <div class="scan-card">
      <h2>${title}</h2>
      ${res.holder_name ? `<p class="scan-name">${esc(res.holder_name)}</p><p class="scan-dni">DNI <b>${esc(res.holder_dni)}</b></p>` : ''}
      ${res.tier ? `<p class="scan-tier">${esc(res.tier)}</p>` : ''}
      ${detail ? `<p class="scan-detail">${esc(detail)}</p>` : ''}
      ${res.result === 'ok' ? '<p class="scan-detail">Verificá que el DNI físico coincida</p>' : ''}
      ${res.offline ? '<p class="scan-detail">Modo sin conexión · se sincroniza luego</p>' : ''}
      <button class="btn btn-block btn-lg" type="button">Siguiente</button>
    </div>`;
  el.hidden = false;
  beep(kind);
  renderDoorStats();
  renderRecent();
  clearTimeout(showScanResult.t);
  showScanResult.t = setTimeout(hideScanResult, kind === 'ok' ? 2500 : 6000);
}
function hideScanResult() {
  $('#scan-result').hidden = true;
  if (state.scanner) state.scanner.resume?.();
}

async function startScanner() {
  if (typeof window.Html5Qrcode === 'undefined') {
    toast('No se pudo cargar el lector de QR. Usá la búsqueda por DNI.', 'error');
    return;
  }
  $('#scanner-wrap').hidden = false;
  $('#btn-scan').hidden = true;
  state.scanner = new window.Html5Qrcode('qr-reader', { verbose: false });
  try {
    await state.scanner.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.75); return { width: s, height: s }; } },
      onScan,
      () => {},
    );
  } catch (err) {
    console.error(err);
    toast('No pudimos abrir la cámara. Revisá los permisos del navegador.', 'error', 6000);
    stopScanner();
  }
}

async function onScan(text) {
  const code = String(text).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const now = Date.now();
  if (!$('#scan-result').hidden) return;
  if (code === state.lastScan.code && now - state.lastScan.at < 4000) return;
  state.lastScan = { code, at: now };
  try { state.scanner.pause(true); } catch { /* noop */ }
  try {
    showScanResult(await doCheckIn({ code }));
  } catch (err) {
    showScanResult({ result: 'error' });
    toast(humanError(err), 'error');
  }
}

function stopScanner() {
  const s = state.scanner;
  state.scanner = null;
  $('#scanner-wrap').hidden = true;
  $('#btn-scan').hidden = false;
  if (s) s.stop().then(() => s.clear()).catch(() => {});
}

function onDoorSearch(e) {
  e?.preventDefault();
  const raw = $('#door-form').q.value.trim();
  const q = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digits = onlyDigits(raw);
  const out = $('#door-results');
  if (!q) { out.innerHTML = ''; return; }

  const matches = allTickets().filter((t) =>
    t.code === q || t.order.code.replace('-', '') === q || (digits.length >= 6 && (t.holder_dni === digits || t.order.dni === digits)));
  if (!matches.length) {
    out.innerHTML = `<div class="door-empty">❌ Sin entradas para <b>${esc(raw)}</b></div>`;
    beep('error');
    return;
  }
  const pendingIds = matches.filter((t) => t.order.status === 'approved' && !t.used_at).map((t) => t.id);
  out.innerHTML = `
    ${pendingIds.length > 1 ? `<button class="btn btn-primary btn-block" data-checkin-all="${pendingIds.join(',')}">Dar ingreso a todas (${pendingIds.length})</button>` : ''}
    ${matches.map((t) => {
      const st = effStatus(t.order);
      const ok = st === 'approved';
      return `
        <div class="door-card ${t.used_at ? 'used' : ok ? 'ok' : 'bad'}">
          <div>
            <b>${esc(t.holder_name)}</b>
            <small>DNI ${esc(t.holder_dni)} · ${esc(tierName(t.tier_id))} · ${esc(t.code)}</small>
            ${t.order.dni !== t.holder_dni ? `<small>Comprada por ${esc(t.order.buyer_name)} (${esc(t.order.dni)})</small>` : ''}
          </div>
          ${t.used_at ? `<span class="tag tag-used">Ingresó ${timeAgo(t.used_at)}</span>`
            : ok ? `<button class="btn btn-primary btn-sm" data-checkin="${esc(t.id)}">Dar ingreso</button>`
              : `<span class="tag tag-bad">${STATUS_LABEL[st]}</span>`}
        </div>`;
    }).join('')}`;
}

async function onDoorAction(e) {
  const one = e.target.closest('[data-checkin]');
  const all = e.target.closest('[data-checkin-all]');
  if (!one && !all) return;
  const ids = one ? [one.dataset.checkin] : all.dataset.checkinAll.split(',');
  e.target.disabled = true;
  let last;
  for (const id of ids) {
    try { last = await doCheckIn({ ticketId: id }); } catch (err) { toast(humanError(err), 'error'); }
  }
  if (last) {
    if (ids.length > 1 && last.result === 'ok') {
      beep('ok');
      toast(`✅ ${ids.length} ingresos registrados`, 'success');
    } else showScanResult(last);
  }
  onDoorSearch();
  renderDoorStats();
  renderRecent();
}

function exportPDF() {
  if (!window.jspdf) return toast('Cargando módulo PDF… probá de nuevo', 'info');
  const rows = allTickets().filter((t) => t.order.status === 'approved')
    .sort((a, b) => a.holder_name.localeCompare(b.holder_name, 'es'));
  if (!rows.length) return toast('No hay entradas aprobadas', 'info');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('p', 'mm', 'a4');
  const header = (y) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    ['#', 'TITULAR', 'DNI', 'TANDA', 'CÓDIGO', 'OK'].forEach((h, i) => doc.text(h, [14, 22, 92, 118, 152, 188][i], y));
    doc.line(14, y + 2, 196, y + 2);
    doc.setFont('helvetica', 'normal');
  };
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(`${CONFIG.event.name} ${CONFIG.event.edition} ${CONFIG.event.year} · Control de ingreso`, 14, 15);
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.text(`${rows.length} entradas · emitido ${new Date().toLocaleString('es-AR')}`, 14, 21);
  let y = 30;
  header(y); y += 7;
  rows.forEach((t, i) => {
    if (y > 285) { doc.addPage(); y = 15; header(y); y += 7; }
    doc.text(String(i + 1), 14, y);
    doc.text(t.holder_name.slice(0, 34), 22, y);
    doc.text(t.holder_dni, 92, y);
    doc.text(tierName(t.tier_id).replace('Tanda Navideña de Regalo', 'Regalo'), 118, y);
    doc.text(t.code, 152, y);
    doc.rect(188, y - 3.5, 4, 4);
    if (t.used_at) doc.text('x', 189, y - 0.3);
    y += 6;
  });
  doc.save(`Puerta_Navidad_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ---------------------------------------------------------------------
//  TRANSFERENCIAS PENDIENTES
// ---------------------------------------------------------------------
function orderTicketsHTML(o) {
  return (o.tickets || []).map((t) => `<li>${esc(t.holder_name)} · DNI ${esc(t.holder_dni)} · ${esc(tierName(t.tier_id))} ${money(t.price)}</li>`).join('');
}

function approvalMessage(o) {
  const url = `${CONFIG.siteUrl.replace(/\/$/, '')}/?dni=${o.dni}`;
  return `Hola ${o.buyer_name.split(' ')[0]}! 🎄 Tu pago para ${CONFIG.event.name} ${CONFIG.event.edition} fue APROBADO.\n\n` +
    `Orden ${o.code} · ${o.quantity} entrada(s).\nTus entradas con QR: ${url}\n\nIngreso con DNI físico. ¡Nos vemos!`;
}

function renderPending() {
  const list = state.orders
    .filter((o) => o.payment_method === 'transfer' && (o.status === 'pending' || state.justApproved.has(o.id)))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  $('#count-pending').textContent = list.filter((o) => o.status === 'pending').length;
  $('#pending-list').innerHTML = list.length ? list.map((o) => {
    const st = effStatus(o);
    if (state.justApproved.has(o.id) && o.status === 'approved') {
      return `<div class="order done"><div><b>✅ ${esc(o.code)} aprobada</b><small>${esc(o.buyer_name)} · ${money(o.total)}</small></div>
        <a class="btn btn-wsp btn-sm" target="_blank" rel="noopener" href="${esc(whatsappLink(o.phone, approvalMessage(o)))}">Avisar por WhatsApp</a></div>`;
    }
    return `
      <div class="order ${st === 'expired' ? 'expired' : ''}">
        <div class="order-head">
          <b>${esc(o.code)}</b>
          <b class="order-total">${money(o.total)}</b>
        </div>
        <p>${esc(o.buyer_name)} · DNI ${esc(o.dni)} · <a href="${esc(whatsappLink(o.phone, `Hola ${o.buyer_name}, te escribo por tu orden ${o.code} 🎄`))}" target="_blank" rel="noopener">${esc(o.phone)}</a></p>
        <ul class="order-tickets">${orderTicketsHTML(o)}</ul>
        <small class="muted">${formatDateTime(o.created_at)} · ${st === 'expired' ? '⚠️ reserva vencida (el cupo ya se liberó)' : `vence ${formatDateTime(o.expires_at)}`}</small>
        <div class="order-actions">
          <button class="btn btn-primary btn-sm" data-approve="${esc(o.id)}">Aprobar</button>
          <button class="btn btn-ghost btn-sm" data-reject="${esc(o.id)}">Rechazar</button>
        </div>
      </div>`;
  }).join('') : '<p class="muted">No hay transferencias pendientes 🎉</p>';
}

async function onPendingAction(e) {
  const ap = e.target.closest('[data-approve]');
  const rj = e.target.closest('[data-reject]');
  if (!ap && !rj) return;
  const id = (ap || rj).dataset.approve || (ap || rj).dataset.reject;
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  if (ap && !confirm(`¿Aprobar ${o.code} de ${o.buyer_name} por ${money(o.total)}?\nVerificá que el dinero haya ingresado.`)) return;
  if (rj && !confirm(`¿Rechazar ${o.code}? Se liberan ${o.quantity} lugar(es).`)) return;
  (ap || rj).disabled = true;
  try {
    if (ap) {
      const r = await api.approveOrder(id);
      state.justApproved.set(id, true);
      toast(r?.was_expired ? 'Aprobada (la reserva estaba vencida: revisá el cupo)' : 'Orden aprobada ✓', 'success');
    } else {
      await api.rejectOrder(id);
      toast('Orden rechazada', 'info');
    }
    await refresh();
  } catch (err) {
    toast(humanError(err), 'error');
    (ap || rj).disabled = false;
  }
}

// ---------------------------------------------------------------------
//  CLIENTES / ÓRDENES
// ---------------------------------------------------------------------
function filteredOrders() {
  const q = $('#orders-q').value.trim().toLowerCase();
  const st = $('#orders-status').value;
  const m = $('#orders-method').value;
  return state.orders.filter((o) => {
    if (st && effStatus(o) !== st) return false;
    if (m && o.payment_method !== m) return false;
    if (!q) return true;
    const hay = [o.code, o.buyer_name, o.dni, o.phone, o.email, ...(o.tickets || []).flatMap((t) => [t.holder_name, t.holder_dni, t.code])]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderOrders() {
  const list = filteredOrders();
  const customers = new Set(list.map((o) => o.dni)).size;
  $('#orders-count').textContent = `${list.length} órdenes · ${customers} clientes`;
  const open = new Set($$('#orders-list details[open]').map((d) => d.dataset.id));
  $('#orders-list').innerHTML = list.slice(0, 300).map((o) => {
    const st = effStatus(o);
    return `
      <details class="order" data-id="${esc(o.id)}" ${open.has(o.id) ? 'open' : ''}>
        <summary>
          <div><b>${esc(o.buyer_name)}</b><small>${esc(o.code)} · DNI ${esc(o.dni)} · ${o.quantity} entr.</small></div>
          <div class="order-side"><span class="pill pill-${st}">${STATUS_LABEL[st]}</span><small>${money(o.total)} · ${o.payment_method === 'mercadopago' ? 'MP' : 'Transf.'}</small></div>
        </summary>
        <p class="muted">📱 <a href="${esc(whatsappLink(o.phone, ''))}" target="_blank" rel="noopener">${esc(o.phone)}</a> · ✉️ ${esc(o.email)} · ${formatDateTime(o.created_at)}</p>
        ${o.admin_note ? `<p class="note">${esc(o.admin_note)}</p>` : ''}
        <ul class="order-tickets">${(o.tickets || []).map((t) => `<li>${esc(t.holder_name)} · DNI ${esc(t.holder_dni)} · ${esc(tierName(t.tier_id))} · <code>${esc(t.code)}</code> ${t.used_at ? `· ✅ ingresó ${formatDateTime(t.used_at)} <button class="btn btn-link btn-sm" data-undo="${esc(t.id)}">deshacer</button>` : ''}</li>`).join('')}</ul>
        <div class="order-actions">
          ${o.status === 'pending' ? `<button class="btn btn-primary btn-sm" data-approve="${esc(o.id)}">Aprobar</button><button class="btn btn-ghost btn-sm" data-reject="${esc(o.id)}">Rechazar</button>` : ''}
          ${o.status === 'approved' ? `<a class="btn btn-wsp btn-sm" target="_blank" rel="noopener" href="${esc(whatsappLink(o.phone, approvalMessage(o)))}">Reenviar entradas</a>` : ''}
        </div>
      </details>`;
  }).join('') || '<p class="muted">Sin resultados.</p>';
}

async function onOrdersAction(e) {
  const undo = e.target.closest('[data-undo]');
  if (undo) {
    e.preventDefault();
    if (!confirm('¿Deshacer el ingreso de esta entrada?')) return;
    try { await api.undoCheckIn(undo.dataset.undo); toast('Ingreso revertido', 'info'); await refresh(); } catch (err) { toast(humanError(err), 'error'); }
    return;
  }
  onPendingAction(e);
}

function exportCSV() {
  const head = ['orden', 'estado', 'pago', 'fecha', 'comprador', 'dni_comprador', 'whatsapp', 'email', 'total_orden',
    'codigo_entrada', 'tanda', 'precio', 'titular', 'dni_titular', 'ingreso'];
  const rows = filteredOrders().flatMap((o) => (o.tickets || []).map((t) => [
    o.code, STATUS_LABEL[effStatus(o)], o.payment_method, formatDateTime(o.created_at), o.buyer_name, o.dni, o.phone, o.email, o.total,
    t.code, tierName(t.tier_id), t.price, t.holder_name, t.holder_dni, t.used_at ? formatDateTime(t.used_at) : '',
  ]));
  const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `clientes_navidad_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------
//  RESUMEN
// ---------------------------------------------------------------------
async function renderSummary() {
  const approved = state.orders.filter((o) => o.status === 'approved');
  const pending = state.orders.filter((o) => effStatus(o) === 'pending');
  const tickets = approved.flatMap((o) => o.tickets || []);
  const rev = (m) => approved.filter((o) => !m || o.payment_method === m).reduce((a, o) => a + o.total, 0);
  const capacity = state.tiers.reduce((a, t) => a + t.capacity, 0);

  $('#kpis').innerHTML = [
    ['Vendidas', `${tickets.length}<small>/${capacity}</small>`],
    ['Reservadas', pending.reduce((a, o) => a + o.quantity, 0)],
    ['Recaudado', money(rev())],
    ['Mercado Pago', money(rev('mercadopago'))],
    ['Transferencias', money(rev('transfer'))],
    ['Ingresaron', tickets.filter((t) => t.used_at).length],
    ['Clientes', new Set(approved.map((o) => o.dni)).size],
  ].map(([k, v]) => `<div class="kpi"><small>${k}</small><b>${v}</b></div>`).join('');

  $('#tier-table').innerHTML = `
    <div class="tt-row tt-head"><span>Tanda</span><span>Precio</span><span>Vend.</span><span>Res.</span><span>Cupo</span></div>
    ${state.tiers.map((t) => {
      const sold = tickets.filter((x) => x.tier_id === t.id).length;
      const res = pending.flatMap((o) => o.tickets || []).filter((x) => x.tier_id === t.id).length;
      const pct = Math.min(100, Math.round(((sold + res) / Math.max(t.capacity, 1)) * 100));
      return `<div class="tt-row"><span>${esc(t.name)}</span><span>${money(t.price)}</span><span>${sold}</span><span>${res}</span><span>${t.capacity}</span>
        <div class="progress tt-bar"><span style="width:${pct}%"></span></div></div>`;
    }).join('')}`;

  try {
    const s = await api.getSettings();
    $('#sales-open').checked = !!s?.sales_open;
  } catch { /* noop */ }
}

// ---------------------------------------------------------------------
//  Eventos
// ---------------------------------------------------------------------
function updateNet() {
  state.online = navigator.onLine;
  const el = $('#net-status');
  el.textContent = state.online ? '● En línea' : '● Sin conexión';
  el.className = `net ${state.online ? 'on' : 'off'}`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function bindEvents() {
  $('#login-form').addEventListener('submit', onLogin);
  $('#btn-logout').addEventListener('click', logout);
  $$('.st-tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('#btn-scan').addEventListener('click', startScanner);
  $('#btn-scan-stop').addEventListener('click', stopScanner);
  $('#scan-result').addEventListener('click', hideScanResult);
  $('#door-form').addEventListener('submit', onDoorSearch);
  $('#door-results').addEventListener('click', onDoorAction);
  $('#btn-pdf').addEventListener('click', exportPDF);

  $('#pending-list').addEventListener('click', onPendingAction);
  $('#orders-list').addEventListener('click', onOrdersAction);
  ['#orders-q', '#orders-status', '#orders-method'].forEach((s) => $(s).addEventListener('input', debounce(renderOrders, 200)));
  $('#btn-csv').addEventListener('click', exportCSV);

  $('#sales-open').addEventListener('change', async (e) => {
    try {
      await api.updateSettings({ sales_open: e.target.checked });
      toast(e.target.checked ? 'Venta abierta' : 'Venta pausada', 'success');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(humanError(err), 'error');
    }
  });

  window.addEventListener('online', () => { updateNet(); syncQueue(); });
  window.addEventListener('offline', updateNet);
}

init();
