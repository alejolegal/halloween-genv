// =====================================================================
//  WEB PÚBLICA · venta de anticipadas
// =====================================================================
import { CONFIG } from './config.js';
import { api, humanError } from './api.js';
import {
  $, $$, esc, money, onlyDigits, toast, copyText, openModal, closeModal,
  ticketCardHTML, renderQRCodes, downloadTicket, timeAgo,
} from './common.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ORDER_KEY = 'xmas_last_order';

const state = {
  status: null,       // respuesta de xmas_sales_status
  qty: 1,
  order: null,        // { code, dni, total, payment_method, expires_at }
  pollTimer: null,
};

// ---------------------------------------------------------------------
//  Textos del evento
// ---------------------------------------------------------------------
function fillEventTexts() {
  $$('[data-ev]').forEach((el) => {
    const v = CONFIG.event[el.dataset.ev];
    if (v) el.textContent = v;
  });
  $('#footer-collab').textContent = CONFIG.event.collab.join(' × ');

  const links = [
    ['whatsappGroup', 'Comunidad de WhatsApp', 'Novedades y sorteos antes que nadie'],
    ['spotifyPlaylist', 'Playlist colaborativa', 'Sumá tus temas para la noche'],
    ['instagram', 'Instagram', 'Seguinos para no perderte nada'],
  ].filter(([k]) => CONFIG.links[k]);
  if (links.length) {
    const box = $('#community');
    box.hidden = false;
    box.innerHTML = links.map(([k, title, sub]) =>
      `<a class="community-link" href="${esc(CONFIG.links[k])}" target="_blank" rel="noopener"><b>${title}</b><small>${sub}</small><span>→</span></a>`).join('');
  }
}

// ---------------------------------------------------------------------
//  Cuenta regresiva
// ---------------------------------------------------------------------
function initCountdown() {
  const target = new Date(CONFIG.event.dateISO).getTime();
  const els = ['d', 'h', 'm', 's'].map((k) => $(`#cd-${k}`));
  const tick = () => {
    const diff = Math.max(0, target - Date.now());
    const parts = [
      Math.floor(diff / 86400000),
      Math.floor((diff % 86400000) / 3600000),
      Math.floor((diff % 3600000) / 60000),
      Math.floor((diff % 60000) / 1000),
    ];
    parts.forEach((v, i) => {
      const txt = String(v).padStart(2, '0');
      if (els[i].textContent !== txt) els[i].textContent = txt;
    });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------------
//  Nieve (canvas liviano) + luces navideñas
// ---------------------------------------------------------------------
function initSnow() {
  const canvas = $('#snow');
  const ctx = canvas.getContext('2d');
  let w, h, flakes;
  const count = () => Math.min(140, Math.round(window.innerWidth / (REDUCED_MOTION ? 30 : 9)));
  const make = () => ({
    x: Math.random() * w, y: Math.random() * h,
    r: Math.random() * 2.2 + 0.6, s: Math.random() * 0.6 + 0.25,
    d: Math.random() * Math.PI * 2, o: Math.random() * 0.5 + 0.35,
  });
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    flakes = Array.from({ length: count() }, make);
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      ctx.globalAlpha = f.o;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      if (!REDUCED_MOTION) {
        f.d += 0.01;
        f.y += f.s;
        f.x += Math.sin(f.d) * 0.35;
        if (f.y > h + 5) { f.y = -5; f.x = Math.random() * w; }
      }
    }
    if (!REDUCED_MOTION && !document.hidden) requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => !document.hidden && !REDUCED_MOTION && requestAnimationFrame(draw));
  draw();

  const lights = $('.lights');
  const n = Math.min(28, Math.round(window.innerWidth / 42));
  lights.innerHTML = Array.from({ length: n }, (_, i) => `<i style="--i:${i}"></i>`).join('');
}

function initReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window) || REDUCED_MOTION) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  els.forEach((el) => io.observe(el));
}

function celebrate() {
  if (REDUCED_MOTION || typeof window.confetti !== 'function') return;
  const colors = ['#e11d48', '#f5c451', '#ffffff', '#16a34a'];
  window.confetti({ particleCount: 140, spread: 80, origin: { y: 0.6 }, colors, zIndex: 9999 });
  setTimeout(() => window.confetti({ particleCount: 80, spread: 120, origin: { y: 0.4 }, colors, zIndex: 9999 }), 300);
}

// ---------------------------------------------------------------------
//  Estado de venta (tandas) + FOMO
// ---------------------------------------------------------------------
const currentTier = () => state.status?.tiers.find((t) => t.id === state.status.current_tier_id) || null;
const totalRemaining = () => state.status?.tiers.reduce((a, t) => a + t.remaining, 0) || 0;

async function loadStatus({ silent = false } = {}) {
  try {
    const prev = state.status;
    const next = await api.salesStatus();
    state.status = next;
    renderStatus();
    if (prev && silent) announceChanges(prev, next);
  } catch (err) {
    console.error(err);
    if (!state.status) {
      $('#live-tier').textContent = 'Venta online';
      $('#live-msg').textContent = humanError(err);
      $('#tiers').innerHTML = `<p class="empty">${esc(humanError(err))}</p>`;
    }
  }
}

function announceChanges(prev, next) {
  const prevTier = prev.tiers.find((t) => t.id === prev.current_tier_id);
  if (prev.current_tier_id !== next.current_tier_id && prevTier) {
    const nt = currentTier();
    toast(nt ? `🔥 ¡${prevTier.name} SOLD OUT! Arrancó ${nt.name} a ${money(nt.price)}` : '🔥 ¡SOLD OUT TOTAL!', 'hot', 7000);
    $$('.tier').forEach((el) => el.classList.add('flash'));
    return;
  }
  const delta = next.total_sold - prev.total_sold;
  const cur = currentTier();
  if (delta > 0 && cur) {
    toast(`🎟️ Se acaban de reservar ${delta} entrada${delta > 1 ? 's' : ''}. Quedan ${cur.remaining} en ${cur.name}`, 'hot');
  }
}

function renderStatus() {
  const s = state.status;
  const cur = currentTier();
  const soldOut = !cur;
  const closed = !s.sales_open;

  // Tarjeta en vivo
  const pct = cur ? Math.round(((cur.sold + cur.reserved) / Math.max(cur.capacity, 1)) * 100) : 100;
  $('#live-tier').textContent = soldOut ? 'SOLD OUT' : cur.name;
  $('#live-tier').classList.toggle('is-gift', cur?.sort === 0);
  $('#live-sold').textContent = s.total_sold.toLocaleString('es-AR');
  $('#live-progress').style.width = `${Math.max(pct, 4)}%`;
  let msg;
  if (closed) msg = 'La venta online está pausada en este momento.';
  else if (soldOut) msg = 'Se agotaron todas las anticipadas. ¡Gracias!';
  else if (cur.remaining <= 10) msg = `🚨 Últimas ${cur.remaining} entradas de ${cur.name} a ${money(cur.price)}`;
  else msg = `Quedan ${cur.remaining} de ${cur.capacity} en ${cur.name} · después sube el precio`;
  if (s.sold_last_24h > 0 && !soldOut) msg += ` · ${s.sold_last_24h} vendidas en las últimas 24 hs`;
  $('#live-msg').textContent = msg;
  $('#live-card').classList.toggle('urgent', !!cur && cur.remaining <= 10);

  // CTA
  const cta = $('#hero-cta');
  cta.classList.toggle('disabled', soldOut || closed);
  $('#hero-cta-price').textContent = cur && !closed ? `· ${money(cur.price)}` : '';
  if (soldOut) cta.firstChild.textContent = 'Anticipadas agotadas ';
  $('#sticky-tier').textContent = cur ? `${cur.name} · quedan ${cur.remaining}` : 'Agotado';
  $('#sticky-price').textContent = cur ? money(cur.price) : '—';
  $('#sticky-btn').disabled = soldOut || closed;

  // Tarjetas de tandas
  $('#tiers').innerHTML = s.tiers.map((t) => tierHTML(t, cur, closed)).join('');

  // Marquesina
  const bits = s.tiers.map((t) => {
    if (t.remaining === 0) return `${t.name} · SOLD OUT`;
    if (cur && t.id === cur.id) return `${t.name} · QUEDAN ${t.remaining}`;
    return `${t.name} · ${money(t.price)}`;
  });
  bits.push(`${s.total_sold} ENTRADAS VENDIDAS`, `${CONFIG.event.dateLabel.toUpperCase()} · ${CONFIG.event.venue.toUpperCase()}`);
  const line = bits.map((b) => `<span>${esc(b)}</span><i>✦</i>`).join('');
  $('#marquee-track').innerHTML = line + line;
}

function tierHTML(t, cur, closed) {
  const isCur = cur && t.id === cur.id;
  const isSold = t.remaining === 0;
  const isNext = !isSold && !isCur;
  const isGift = t.sort === 0;
  const pct = Math.round(((t.sold + t.reserved) / Math.max(t.capacity, 1)) * 100);
  const save = isCur ? nextPriceDiff(t) : 0;

  let foot;
  if (isSold) foot = `<span class="tier-state">Agotada · ${t.capacity}/${t.capacity}</span>`;
  else if (isCur) {
    foot = `
      <div class="progress"><span style="width:${Math.max(pct, 4)}%"></span></div>
      <span class="tier-state hot">${t.remaining <= 10 ? '🚨 ' : '🔥 '}Quedan ${t.remaining} de ${t.capacity}</span>
      <button class="btn btn-primary btn-block" type="button" data-buy ${closed ? 'disabled' : ''}>Comprar ahora</button>
      ${save > 0 ? `<small class="tier-save">Ahorrás ${money(save)} vs. la próxima tanda</small>` : ''}`;
  } else foot = '<span class="tier-state">🔒 Se habilita al agotarse la anterior</span>';

  return `
    <article class="tier reveal in ${isCur ? 'is-current' : ''} ${isSold ? 'is-sold' : ''} ${isNext ? 'is-next' : ''} ${isGift ? 'is-gift' : ''}">
      ${isGift ? '<span class="tier-ribbon">🎁 Regalo</span>' : ''}
      ${isCur ? '<span class="tier-live"><i></i> EN VENTA</span>' : ''}
      <h3 class="tier-name">${esc(t.name)}</h3>
      <p class="tier-sub">${esc(t.subtitle || '')}</p>
      <p class="tier-price">${money(t.price)}</p>
      ${foot}
      ${isSold ? '<span class="stamp">SOLD OUT</span>' : ''}
    </article>`;
}

function nextPriceDiff(t) {
  const next = state.status.tiers.find((x) => x.sort > t.sort);
  return next ? next.price - t.price : 0;
}

/** Previsualiza cómo se reparten N entradas entre tandas (el servidor es la fuente de verdad). */
function allocate(qty) {
  const lines = [];
  let left = qty;
  for (const t of state.status.tiers) {
    if (left <= 0) break;
    const take = Math.min(t.remaining, left);
    if (take > 0) lines.push({ name: t.name, price: t.price, qty: take });
    left -= take;
  }
  return { lines, total: lines.reduce((a, l) => a + l.price * l.qty, 0), ok: left <= 0 };
}

// ---------------------------------------------------------------------
//  Flujo de compra
// ---------------------------------------------------------------------
function showStep(id) {
  $$('#modal-buy .step').forEach((s) => { s.hidden = s.id !== id; });
  $('#modal-buy .modal-box').scrollTop = 0;
}

function maxQty() {
  return Math.max(1, Math.min(state.status?.max_per_order || 4, totalRemaining()));
}

async function openBuy() {
  if (!state.status) await loadStatus();
  if (!state.status || !currentTier() || !state.status.sales_open) {
    toast('No hay entradas disponibles en este momento', 'info');
    return;
  }

  // ¿Hay una compra pendiente guardada? Retomarla.
  const saved = getSavedOrder();
  if (saved) {
    try {
      const o = await api.orderStatus(saved.code, saved.dni);
      if (o && o.status === 'pending') {
        state.order = o;
        openModal('modal-buy');
        showWait(o);
        toast('Tenés una compra pendiente. Podés completarla o cancelarla.', 'info');
        return;
      }
      if (!o || o.status !== 'approved') clearSavedOrder();
    } catch { /* sin conexión: seguimos */ }
  }

  state.qty = Math.min(state.qty, maxQty());
  renderQty();
  $('#form-error').textContent = '';
  showStep('step-form');
  openModal('modal-buy');
}

function renderQty() {
  $('#qty-val').textContent = state.qty;
  $('#qty-minus').disabled = state.qty <= 1;
  $('#qty-plus').disabled = state.qty >= maxQty();
  renderAttendees();
  renderSummary();
}

function renderAttendees() {
  const box = $('#attendees');
  const prev = $$('input', box).reduce((acc, i) => ({ ...acc, [i.name]: i.value }), {});
  const selfGoes = $('#self-goes')?.checked ?? true;
  let html = `
    <label class="check"><input type="checkbox" id="self-goes" ${selfGoes ? 'checked' : ''}> Una de las entradas es para mí</label>`;
  const start = selfGoes ? 2 : 1;
  for (let i = start; i <= state.qty; i++) {
    html += `
      <fieldset class="fields attendee">
        <legend>Entrada ${i} · asistente</legend>
        <label>Nombre y apellido<input name="a${i}-name" required minlength="3" maxlength="80" value="${esc(prev[`a${i}-name`] || '')}"></label>
        <label>DNI<input name="a${i}-dni" inputmode="numeric" required maxlength="10" value="${esc(prev[`a${i}-dni`] || '')}" placeholder="Sin puntos"></label>
      </fieldset>`;
  }
  box.innerHTML = html;
  $('#self-goes').addEventListener('change', renderAttendees);
}

function renderSummary() {
  const a = allocate(state.qty);
  const cur = currentTier();
  $('#buy-tier-label').textContent = cur ? `${cur.name} · ${money(cur.price)} c/u · quedan ${cur.remaining}` : '';
  $('#buy-summary').innerHTML = `
    ${a.lines.map((l) => `<div><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.qty * l.price)}</span></div>`).join('')}
    <div class="summary-total"><span>Total</span><b>${money(a.total)}</b></div>
    ${a.lines.length > 1 ? '<small>Tu compra combina dos tandas porque la actual está por agotarse.</small>' : ''}`;
}

function collectForm() {
  const f = $('#step-form');
  const val = (n) => (f.elements[n]?.value || '').trim();
  const buyer = { name: val('name'), dni: onlyDigits(val('dni')), phone: onlyDigits(val('phone')), email: val('email') };
  const errors = [];
  if (buyer.name.length < 3) errors.push('Ingresá tu nombre y apellido.');
  if (!/^\d{7,9}$/.test(buyer.dni)) errors.push('Tu DNI debe tener entre 7 y 9 números.');
  if (!/^\d{8,15}$/.test(buyer.phone)) errors.push('Ingresá un WhatsApp válido.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyer.email)) errors.push('Ingresá un email válido.');

  const selfGoes = $('#self-goes').checked;
  const attendees = selfGoes ? [{ name: buyer.name, dni: buyer.dni }] : [];
  for (let i = selfGoes ? 2 : 1; i <= state.qty; i++) {
    const a = { name: val(`a${i}-name`), dni: onlyDigits(val(`a${i}-dni`)) };
    if (a.name.length < 3 || !/^\d{7,9}$/.test(a.dni)) errors.push(`Completá nombre y DNI válido de la entrada ${i}.`);
    attendees.push(a);
  }
  const dnis = attendees.map((a) => a.dni);
  if (new Set(dnis).size !== dnis.length) errors.push('Cada entrada debe tener un DNI distinto.');
  return { buyer, attendees, errors };
}

let pendingPurchase = null;

function onSubmitForm(e) {
  e.preventDefault();
  const data = collectForm();
  if (data.errors.length) {
    $('#form-error').textContent = data.errors[0];
    return;
  }
  $('#form-error').textContent = '';
  pendingPurchase = data;
  const a = allocate(state.qty);
  $('#pay-total').innerHTML = `${state.qty} entrada${state.qty > 1 ? 's' : ''} · Total <b>${money(a.total)}</b>`;
  $('#pay-error').textContent = '';
  showStep('step-pay');
}

async function onChooseMethod(method, btn) {
  if (!pendingPurchase) return showStep('step-form');
  $$('.pay-option').forEach((b) => { b.disabled = true; });
  btn.classList.add('loading');
  $('#pay-error').textContent = '';
  try {
    const res = await api.createOrder(pendingPurchase.buyer, pendingPurchase.attendees, method);
    state.order = { ...res, dni: pendingPurchase.buyer.dni, buyer_name: pendingPurchase.buyer.name, status: 'pending' };
    saveOrder({ code: res.code, dni: pendingPurchase.buyer.dni });
    loadStatus({ silent: false });

    if (method === 'mercadopago') {
      btn.querySelector('small').textContent = 'Abriendo Mercado Pago…';
      const url = await api.mpCreate(res.code, pendingPurchase.buyer.dni);
      window.location.href = url;
      return;
    }
    showTransfer(state.order);
  } catch (err) {
    console.error(err);
    $('#pay-error').textContent = humanError(err);
    if (/DNI|NOMBRE|CANTIDAD|SIN_CUPO/.test(err?.message || '')) loadStatus();
  } finally {
    $$('.pay-option').forEach((b) => { b.disabled = false; b.classList.remove('loading'); });
  }
}

function showTransfer(o) {
  const t = CONFIG.transfer;
  const hours = Math.max(1, Math.round((new Date(o.expires_at) - Date.now()) / 3600000));
  $('#tr-hold').textContent = `${hours} hs`;
  $('#tr-code').textContent = o.code;
  $('#tr-total').textContent = money(o.total);
  $('#tr-alias').textContent = t.alias;
  $('#tr-cvu').textContent = t.cvu;
  $('#tr-holder').textContent = t.holder;
  $('#tr-bank').textContent = `${t.bank} · Cuenta ${t.account}`;
  const text = `Hola! Hice la transferencia para ${CONFIG.event.name} ${CONFIG.event.edition} 🎄\n\n` +
    `• Orden: ${o.code}\n• Titular: ${o.buyer_name}\n• DNI: ${o.dni}\n• Entradas: ${o.quantity}\n• Monto: ${money(o.total)}\n\nAdjunto el comprobante.`;
  $('#tr-wsp').href = `https://wa.me/${CONFIG.whatsappPhone}?text=${encodeURIComponent(text)}`;
  showStep('step-transfer');
  startPolling(); // si el staff aprueba mientras está abierta, se muestran las entradas solas
}

function showWait(o) {
  const isMp = o.payment_method === 'mercadopago';
  $('#wait-title').textContent = isMp ? 'Confirmando tu pago' : 'Estamos validando tu transferencia';
  $('#wait-text').textContent = isMp
    ? 'Si ya pagaste, tu entrada aparece en segundos. Si no, podés completar el pago.'
    : 'Apenas validemos el comprobante tus entradas se habilitan acá y en "Mis entradas". Podés cerrar esta ventana.';
  $('#wait-code').textContent = o.code;
  const pay = $('#wait-pay');
  pay.hidden = !(isMp && o.mp_init_point);
  if (o.mp_init_point) pay.href = o.mp_init_point;
  showStep('step-wait');
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => checkOrder(true), 6000);
}
function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function checkOrder(silent = false) {
  if (!state.order) return;
  try {
    const o = await api.orderStatus(state.order.code, state.order.dni);
    if (!o) return;
    state.order = o;
    if (o.status === 'approved') {
      stopPolling();
      showTickets(o);
      celebrate();
      loadStatus();
    } else if (['rejected', 'cancelled', 'expired'].includes(o.status)) {
      stopPolling();
      clearSavedOrder();
      const label = { rejected: 'rechazada', cancelled: 'cancelada', expired: 'vencida' }[o.status];
      $('#wait-title').textContent = `Tu reserva fue ${label}`;
      $('#wait-text').textContent = 'Los lugares se liberaron. Podés iniciar una nueva compra.';
      $('#wait-pay').hidden = true;
      $('#wait-cancel').hidden = true;
      $('#wait-check').textContent = 'Nueva compra';
      $('#wait-check').onclick = () => { $('#wait-check').onclick = null; resetWaitUI(); state.order = null; openBuy(); };
    } else if (!silent) {
      toast('Tu pago todavía está en revisión', 'info');
    }
  } catch (err) {
    if (!silent) toast(humanError(err), 'error');
  }
}

function resetWaitUI() {
  $('#wait-cancel').hidden = false;
  $('#wait-check').textContent = 'Actualizar estado';
}

async function cancelPending() {
  if (!state.order || !confirm('¿Cancelar la reserva? Se liberan los lugares.')) return;
  try {
    await api.cancelOrder(state.order.code, state.order.dni);
    stopPolling();
    clearSavedOrder();
    state.order = null;
    closeModal('modal-buy');
    toast('Reserva cancelada', 'info');
    loadStatus();
  } catch (err) {
    toast(humanError(err), 'error');
  }
}

function showTickets(o, box = $('#tickets-box')) {
  const tickets = (o.tickets || []).filter((t) => t.code);
  box.innerHTML = tickets.map((t) => `
    <div class="ticket-wrap">
      ${ticketCardHTML(t, o)}
      <button type="button" class="btn btn-ghost btn-block btn-sm" data-download="${esc(t.code)}" data-holder="${esc(t.holder_name)}">Descargar entrada</button>
    </div>`).join('');
  if (box.id === 'tickets-box') showStep('step-tickets');
  renderQRCodes(box);
}

// ---------------------------------------------------------------------
//  Retorno desde Mercado Pago (?orden=...&dni=...&payment_id=...)
// ---------------------------------------------------------------------
async function handleReturnFromMp() {
  const p = new URLSearchParams(location.search);
  const code = p.get('orden');
  const dni = onlyDigits(p.get('dni'));
  if (!code || !dni) return false;
  const paymentId = p.get('payment_id') || p.get('collection_id');
  const mpStatus = p.get('status') || p.get('collection_status');
  history.replaceState(null, '', location.pathname + (api.mode === 'demo' ? '?demo=1' : ''));

  state.order = { code, dni, payment_method: 'mercadopago' };
  saveOrder({ code, dni });
  openModal('modal-buy');
  showWait({ code, payment_method: 'mercadopago' });

  if (paymentId && paymentId !== 'null') {
    try { await api.mpVerify(code, dni, paymentId); } catch (e) { console.warn(e); }
  }
  await checkOrder(true);
  if (state.order?.status === 'pending' && mpStatus && /rejected|failure|null/.test(mpStatus)) {
    toast('El pago no se completó. Podés reintentarlo.', 'error', 6000);
  }
  return true;
}

// ---------------------------------------------------------------------
//  Mis entradas (consulta por DNI)
// ---------------------------------------------------------------------
async function onLookup(e) {
  e?.preventDefault();
  const dni = onlyDigits($('#lookup-form').elements.dni.value);
  const out = $('#lookup-out');
  if (!/^\d{7,9}$/.test(dni)) {
    out.innerHTML = '<p class="form-error">Ingresá un DNI válido (7 a 9 números).</p>';
    return;
  }
  out.innerHTML = '<p class="muted">Buscando…</p>';
  try {
    const orders = await api.lookup(dni);
    if (!orders.length) {
      out.innerHTML = `<p class="muted">No encontramos entradas para el DNI <b>${esc(dni)}</b>.</p>`;
      return;
    }
    out.innerHTML = orders.map((o) => {
      const head = `<div class="lk-head"><b>Orden ${esc(o.code)}</b><span class="pill pill-${esc(o.status)}">${statusLabel(o)}</span></div>`;
      if (o.status === 'approved') {
        return `<div class="lk-order">${head}<div class="tickets-box" data-order="${esc(o.code)}"></div></div>`;
      }
      const extra = o.status === 'pending'
        ? (o.payment_method === 'mercadopago' && o.mp_init_point
          ? `<a class="btn btn-primary btn-sm" href="${esc(o.mp_init_point)}">Completar pago</a>`
          : `<small class="muted">Esperando validación de la transferencia (${money(o.total)}).</small>`)
        : '<small class="muted">La reserva venció y los lugares se liberaron.</small>';
      return `<div class="lk-order">${head}<p class="muted">${o.tickets.length} entrada(s) · ${o.tickets.map((t) => esc(t.holder_name)).join(', ')}</p>${extra}</div>`;
    }).join('');
    orders.filter((o) => o.status === 'approved').forEach((o) => showTickets(o, $(`[data-order="${CSS.escape(o.code)}"]`, out)));
  } catch (err) {
    out.innerHTML = `<p class="form-error">${esc(humanError(err))}</p>`;
  }
}

function statusLabel(o) {
  return { approved: 'Habilitada', pending: 'Pendiente', expired: 'Vencida', rejected: 'Rechazada', cancelled: 'Cancelada' }[o.status] || o.status;
}

// ---------------------------------------------------------------------
//  Persistencia local de la última compra
// ---------------------------------------------------------------------
function saveOrder(ref) { try { localStorage.setItem(ORDER_KEY, JSON.stringify(ref)); } catch { /* noop */ } }
function getSavedOrder() { try { return JSON.parse(localStorage.getItem(ORDER_KEY)); } catch { return null; } }
function clearSavedOrder() { try { localStorage.removeItem(ORDER_KEY); } catch { /* noop */ } }

// ---------------------------------------------------------------------
//  Eventos
// ---------------------------------------------------------------------
function bindEvents() {
  $('#btn-my-tickets').addEventListener('click', () => {
    $('#lookup-out').innerHTML = '';
    const saved = getSavedOrder();
    if (saved?.dni) $('#lookup-form').elements.dni.value = saved.dni;
    openModal('modal-lookup');
    if (saved?.dni) onLookup();
  });
  $('#lookup-form').addEventListener('submit', onLookup);

  $('#hero-cta').addEventListener('click', (e) => {
    e.preventDefault();
    if ($('#hero-cta').classList.contains('disabled')) return;
    openBuy();
  });
  $('#sticky-btn').addEventListener('click', openBuy);
  $('#tiers').addEventListener('click', (e) => e.target.closest('[data-buy]') && openBuy());

  $('#qty-minus').addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); renderQty(); });
  $('#qty-plus').addEventListener('click', () => { state.qty = Math.min(maxQty(), state.qty + 1); renderQty(); });
  $('#step-form').addEventListener('submit', onSubmitForm);
  $$('.pay-option').forEach((b) => b.addEventListener('click', () => onChooseMethod(b.dataset.method, b)));
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => showStep(b.dataset.back)));

  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.copy;
    copyText(CONFIG.transfer[k], k === 'alias' ? 'Alias copiado' : 'CVU copiado');
  }));
  $('#tr-done').addEventListener('click', () => showWait(state.order));
  $('#tr-wsp').addEventListener('click', () => setTimeout(() => showWait(state.order), 400));
  $('#wait-check').addEventListener('click', () => checkOrder(false));
  $('#wait-cancel').addEventListener('click', cancelPending);
  $('#modal-buy').addEventListener('modal:close', stopPolling);

  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-download]');
    if (d) downloadTicket(d.dataset.download, d.dataset.holder);
  });

  // Barra fija de compra cuando el CTA principal sale de pantalla
  const sticky = $('#sticky-buy');
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([en]) => { sticky.hidden = en.isIntersecting; }, { threshold: 0 }).observe($('#hero-cta'));
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus({ silent: true }); });
}

// ---------------------------------------------------------------------
//  Inicio
// ---------------------------------------------------------------------
async function start() {
  fillEventTexts();
  initCountdown();
  initSnow();
  initReveal();
  bindEvents();
  if (api.mode === 'demo') toast('Modo demo: los datos son de prueba', 'info', 5000);

  await loadStatus();
  setInterval(() => !document.hidden && loadStatus({ silent: true }), 15000);

  const returned = await handleReturnFromMp();
  if (!returned) {
    const p = new URLSearchParams(location.search);
    const dni = onlyDigits(p.get('dni'));
    if (dni) {
      $('#lookup-form').elements.dni.value = dni;
      openModal('modal-lookup');
      onLookup();
    }
  }

  if (state.status?.last_sale_at && currentTier()) {
    setTimeout(() => toast(`🎄 Última compra ${timeAgo(state.status.last_sale_at)} · quedan ${currentTier().remaining} en ${currentTier().name}`, 'hot', 5500), 3500);
  }
}

start();
