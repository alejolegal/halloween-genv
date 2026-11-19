// Utilidades compartidas entre la web pública y el panel de staff.
import { CONFIG } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapa texto para insertarlo en HTML (evita XSS con nombres de usuarios). */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
export const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

export function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.round(diff / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

// ---------------------------------------------------------------------
//  Toasts
// ---------------------------------------------------------------------
export function toast(message, type = 'info', ms = 4200) {
  let host = $('#toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

export async function copyText(text, label = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${label} ✓`, 'success', 2200);
}

// ---------------------------------------------------------------------
//  Modales accesibles (Esc para cerrar, foco, bloqueo de scroll)
// ---------------------------------------------------------------------
let openModals = [];
export function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('open'));
  if (!openModals.includes(id)) openModals.push(id);
  document.body.classList.add('no-scroll');
  setTimeout(() => m.querySelector('[autofocus], input, button.btn')?.focus({ preventScroll: true }), 60);
}
export function closeModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('open');
  setTimeout(() => { m.hidden = true; }, 220);
  openModals = openModals.filter((x) => x !== id);
  if (!openModals.length) document.body.classList.remove('no-scroll');
  m.dispatchEvent(new CustomEvent('modal:close'));
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) closeModal(openModals[openModals.length - 1]);
});
document.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) closeModal(closer.closest('.modal').id);
  else if (e.target.classList?.contains('modal')) closeModal(e.target.id);
});

// ---------------------------------------------------------------------
//  Tickets con QR
// ---------------------------------------------------------------------
export function ticketCardHTML(t, order) {
  const ev = CONFIG.event;
  return `
    <article class="ticket" id="ticket-${esc(t.code)}">
      <div class="ticket-main">
        <div class="ticket-top">
          <span class="ticket-brand">${esc(ev.brand)} · ${esc(ev.edition)}</span>
          <span class="ticket-tier">${esc(t.tier)}</span>
        </div>
        <h3 class="ticket-title">${esc(ev.name)} <em>${esc(ev.year)}</em></h3>
        <dl class="ticket-fields">
          <div><dt>Titular</dt><dd>${esc(t.holder_name)}</dd></div>
          <div><dt>DNI</dt><dd>${esc(t.holder_dni)}</dd></div>
          <div><dt>Fecha</dt><dd>${esc(ev.dateLabel)} · ${esc(ev.timeLabel)}</dd></div>
          <div><dt>Lugar</dt><dd>${esc(ev.venue)}</dd></div>
        </dl>
        <p class="ticket-note">Entrada personal e intransferible · Presentá DNI físico</p>
      </div>
      <div class="ticket-stub">
        <div class="ticket-qr" data-qr="${esc(t.code)}" aria-label="Código QR de la entrada"></div>
        <code class="ticket-code">${esc(t.code)}</code>
        <span class="ticket-order">${esc(order?.code || '')} · ${esc(t.seq)}/${esc(order?.quantity || order?.tickets?.length || 1)}</span>
        ${t.used ? '<span class="ticket-used">INGRESADA</span>' : ''}
      </div>
    </article>`;
}

export function renderQRCodes(root) {
  $$('[data-qr]', root).forEach((el) => {
    if (el.dataset.rendered || typeof window.QRCode === 'undefined') return;
    el.dataset.rendered = '1';
    new window.QRCode(el, {
      text: el.dataset.qr,
      width: 148,
      height: 148,
      colorDark: '#0b1f17',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  });
}

export async function downloadTicket(code, holderName) {
  const el = document.getElementById(`ticket-${code}`);
  if (!el || typeof window.html2canvas === 'undefined') {
    toast('Hacé una captura de pantalla de tu entrada', 'info');
    return;
  }
  const canvas = await window.html2canvas(el, { backgroundColor: '#07140f', scale: 2, useCORS: true });
  const a = document.createElement('a');
  a.download = `Entrada_${CONFIG.event.name}_${code}_${String(holderName).replace(/[^\w]+/g, '_')}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

export function whatsappLink(phone, text) {
  const p = onlyDigits(phone);
  const full = p.startsWith('54') ? p : '549' + p.replace(/^0/, '');
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}
