// ==========================================
// CONFIGURACIÓN GENERAL & SUPABASE
// ==========================================
const SUPABASE_URL = 'https://anubyojemmaybrcmzqdo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFudWJ5b2plbW1heWJyY216cWRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1OTg3NjUsImV4cCI6MjEwNjE3NDc2NX0.JH3fXRo8esF9s9G7sXNQr2L_5JPg2ppYrbOx26MDS-E'; // <-- PEGA TU CLAVE ANON AQUÍ

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CONFIG = {
  adminPin: '2026',
  whatsappPhone: '5493794000000', // Modificá con tu número con código de área
  maxVipStock: 50,
  spotifyUrl: 'https://open.spotify.com',
  wspGroupUrl: 'https://chat.whatsapp.com'
};

const spLink = document.getElementById('btn-spotify-link');
const wspLink = document.getElementById('btn-wsp-group-link');
if (spLink) spLink.href = CONFIG.spotifyUrl;
if (wspLink) wspLink.href = CONFIG.wspGroupUrl;

let cloudOrders = [];

// ==========================================
// SINCRONIZACIÓN EN TIEMPO REAL CON SUPABASE
// ==========================================
async function fetchOrders() {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (data) {
      cloudOrders = data.map(o => ({
        firestoreId: o.id,
        orderId: o.order_id,
        ticketId: o.ticket_id,
        ticketIndex: o.ticket_index,
        ticketTotal: o.ticket_total,
        name: o.name,
        buyerName: o.buyer_name,
        dni: o.dni,
        phone: o.phone,
        email: o.email,
        ticketType: o.ticket_type,
        amount: Number(o.amount),
        status: o.status,
        used: o.used,
        createdAt: o.created_at
      }));

      updateMetrics();
      renderApprovalsList();
      renderDoorList();
      checkVipAvailability();
    }
  } catch (err) {
    console.error("Error al obtener órdenes de Supabase:", err.message);
  }
}

// Carga inicial y escucha cambios en tiempo real
fetchOrders();
supabase
  .channel('public:orders')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
    fetchOrders();
  })
  .subscribe();

// ==========================================
// CONTROL DE STOCK VIP (50 CUPOS)
// ==========================================
function checkVipAvailability() {
  const vipCount = cloudOrders.filter(o => o.ticketType && o.ticketType.includes('VIP') && o.status !== 'rejected').length;
  const remaining = Math.max(0, CONFIG.maxVipStock - vipCount);
  const label = document.getElementById('vip-stock-label');
  const btn = document.getElementById('btn-buy-vip');

  if (label) {
    label.innerHTML = `Cupos restantes: <strong>${remaining}/${CONFIG.maxVipStock}</strong>`;
  }

  if (btn) {
    if (remaining === 0) {
      btn.disabled = true;
      btn.textContent = 'AGOTADO';
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.disabled = false;
      btn.textContent = 'COMPRAR VIP';
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
  }
}

// ==========================================
// CUENTA REGRESIVA
// ==========================================
function initCountdown() {
  const eventDate = new Date('2026-10-31T23:59:59').getTime();
  function tick() {
    const diff = eventDate - new Date().getTime();
    if (diff > 0) {
      document.getElementById('cd-days').textContent = String(Math.floor(diff / (1000 * 60 * 60 * 24))).padStart(2, '0');
      document.getElementById('cd-hours').textContent = String(Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
      document.getElementById('cd-mins').textContent = String(Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
      document.getElementById('cd-secs').textContent = String(Math.floor((diff % (1000 * 60)) / 1000)).padStart(2, '0');
    }
  }
  setInterval(tick, 1000);
  tick();
}
initCountdown();

// ==========================================
// CHECKOUT MULTI-CANTIDAD
// ==========================================
let activePlan = { name: '', unitPrice: 0 };
let activeCreatedOrders = [];

function openCheckout(name, price) {
  activePlan = { name, unitPrice: price };
  
  document.getElementById('co-ticket-name').textContent = name;
  document.getElementById('co-unit-price').textContent = `$${price.toLocaleString('es-AR')} ARS`;
  
  const selectQty = document.getElementById('cust-qty');
  selectQty.value = "1";

  if (name.includes('VIP')) {
    const vipCount = cloudOrders.filter(o => o.ticketType && o.ticketType.includes('VIP') && o.status !== 'rejected').length;
    const remaining = Math.max(0, CONFIG.maxVipStock - vipCount);
    
    Array.from(selectQty.options).forEach(opt => {
      opt.disabled = parseInt(opt.value) > remaining;
    });
  } else {
    Array.from(selectQty.options).forEach(opt => opt.disabled = false);
  }

  updateCheckoutTotal();

  document.getElementById('co-step-form').classList.remove('hidden');
  document.getElementById('co-step-transfer').classList.add('hidden');
  document.getElementById('co-step-pending').classList.add('hidden');
  document.getElementById('co-step-ticket').classList.add('hidden');

  document.getElementById('orderForm').reset();
  document.getElementById('cust-qty').value = "1";
  document.getElementById('modal-checkout').classList.remove('hidden');
}

function updateCheckoutTotal() {
  const qty = parseInt(document.getElementById('cust-qty').value) || 1;
  const total = activePlan.unitPrice * qty;
  document.getElementById('co-ticket-price').textContent = `$${total.toLocaleString('es-AR')} ARS`;
  document.getElementById('transfer-amount').textContent = `$${total.toLocaleString('es-AR')} ARS`;
}

function closeCheckout() {
  document.getElementById('modal-checkout').classList.add('hidden');
  activeCreatedOrders = [];
}

async function handleOrderSubmit(e) {
  e.preventDefault();

  const name = document.getElementById('cust-name').value.trim();
  const dni = document.getElementById('cust-dni').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const email = document.getElementById('cust-email').value.trim();
  const qty = parseInt(document.getElementById('cust-qty').value) || 1;

  if (activePlan.name.includes('VIP')) {
    const vipCount = cloudOrders.filter(o => o.ticketType && o.ticketType.includes('VIP') && o.status !== 'rejected').length;
    if (vipCount + qty > CONFIG.maxVipStock) {
      alert(`Lo sentimos, solo quedan ${CONFIG.maxVipStock - vipCount} cupos VIP disponibles.`);
      return;
    }
  }

  const sharedOrderId = 'ORD-' + Math.floor(1000 + Math.random() * 9000);
  const rowsToInsert = [];

  for (let i = 0; i < qty; i++) {
    const ticketId = 'TKT-' + Math.floor(100000 + Math.random() * 900000);
    rowsToInsert.push({
      order_id: sharedOrderId,
      ticket_index: (i + 1),
      ticket_total: qty,
      ticket_id: ticketId,
      name: qty > 1 ? `${name} [${i+1}/${qty}]` : name,
      buyer_name: name,
      dni: dni,
      phone: phone,
      email: email,
      ticket_type: activePlan.name,
      amount: activePlan.unitPrice,
      status: 'pending',
      used: false
    });
  }

  try {
    const { data, error } = await supabase.from('orders').insert(rowsToInsert).select();
    if (error) throw error;

    activeCreatedOrders = data.map(o => ({
      firestoreId: o.id,
      orderId: o.order_id,
      ticketId: o.ticket_id,
      name: o.name,
      buyerName: o.buyer_name,
      dni: o.dni,
      amount: Number(o.amount),
      ticketType: o.ticket_type
    }));

    document.getElementById('co-step-form').classList.add('hidden');
    document.getElementById('transfer-order-code').textContent = sharedOrderId;
    document.getElementById('co-step-transfer').classList.remove('hidden');
  } catch (err) {
    alert("Error al registrar en Supabase: " + err.message);
  }
}

function copyAlias() {
  const alias = document.getElementById('transfer-alias').textContent;
  navigator.clipboard.writeText(alias).then(() => alert('Alias copiado: ' + alias));
}

function sendWhatsAppProof() {
  if (activeCreatedOrders.length === 0) return;
  const o = activeCreatedOrders[0];
  const qty = activeCreatedOrders.length;
  const total = o.amount * qty;

  const text = `Hola Alejo! Realicé la transferencia para HAVANNA CLUB // HALLOWEEN OBSESSION 2026.%0A%0A` +
    `• Orden: ${o.orderId} (${qty} ticket${qty > 1 ? 's' : ''})%0A` +
    `• Titular: ${o.buyerName || o.name}%0A` +
    `• DNI: ${o.dni}%0A` +
    `• Sector: ${o.ticketType}%0A` +
    `• Total: $${total.toLocaleString('es-AR')} ARS%0A%0A` +
    `Adjunto el comprobante bancario para validar los tickets. Muchas gracias!`;

  window.open(`https://wa.me/${CONFIG.whatsappPhone}?text=${text}`, '_blank');
  showPendingScreen();
}

function showPendingScreen() {
  if (activeCreatedOrders.length === 0) return;
  const o = activeCreatedOrders[0];

  document.getElementById('co-step-transfer').classList.add('hidden');
  document.getElementById('co-step-pending').classList.remove('hidden');

  document.getElementById('pend-code').textContent = `${o.orderId} (${activeCreatedOrders.length} tickets)`;
  document.getElementById('pend-name').textContent = o.buyerName || o.name;
  document.getElementById('pend-dni').textContent = o.dni;
}

function checkStatusFromCurrent() {
  if (activeCreatedOrders.length === 0) return;
  const sharedOrderId = activeCreatedOrders[0].orderId;
  const freshOrders = cloudOrders.filter(o => o.orderId === sharedOrderId);
  const approved = freshOrders.filter(o => o.status === 'approved');

  if (approved.length > 0) {
    document.getElementById('co-step-pending').classList.add('hidden');
    renderMultipleTicketsUI(approved);
  } else {
    alert('Tus comprobantes siguen en proceso de verificación por el Staff de Havanna Club.');
  }
}

// ==========================================
// RENDERIZADO DE TICKETS
// ==========================================
function renderMultipleTicketsUI(ordersList) {
  document.getElementById('co-step-ticket').classList.remove('hidden');
  const box = document.getElementById('ticket-render-box');
  box.innerHTML = '';

  if (typeof confetti === 'function') {
    confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } });
  }

  if (ordersList.length > 1) {
    const groupNotice = document.createElement('div');
    groupNotice.style.cssText = "font-family:var(--font-mono); font-size:0.75rem; color:#34d399; margin-bottom:1rem; text-align:center;";
    groupNotice.innerHTML = `✓ Se encontraron <strong>${ordersList.length} entradas</strong> asociadas. Mostrando todos los tickets con sus QR individuales:`;
    box.appendChild(groupNotice);
  }

  ordersList.forEach(order => {
    const isVip = order.ticketType && order.ticketType.includes('VIP');
    const card = document.createElement('div');
    card.className = `one-wish-ticket ${isVip ? 'ticket-vip-style' : ''}`;
    card.innerHTML = `
      <div class="ticket-main-body">
        <div class="ow-curve-header">${isVip ? 'VIP OBSESSION' : 'ONE NIGHT WISH'}</div>
        <div class="ow-legend-row">
          <span>HAVANNA CLUB • ITÁ IBATÉ</span>
          <span>YOU ONLY GET ONE ENTRY</span>
        </div>

        <div class="ow-data-grid">
          <div class="ow-field"><span>TITULAR:</span><strong>${order.name}</strong></div>
          <div class="ow-field"><span>DNI:</span><strong>${order.dni}</strong></div>
          <div class="ow-field"><span>SECTOR:</span><strong>${order.ticketType.toUpperCase()}</strong></div>
          <div class="ow-field"><span>FECHA:</span><strong>31 OCT // 23:59 HS</strong></div>
        </div>

        ${isVip ? `
          <div class="ow-vip-seal">
            ★ INCLUYE 1 CONSUMICIÓN GIN TONIC DE CORTESÍA ★
          </div>
        ` : ''}
      </div>

      <div class="ticket-stub">
        <div class="stub-qr-box">
          <div id="ticket-qr-${order.ticketId}"></div>
        </div>
        <div class="stub-id">${order.ticketId}</div>
      </div>
    `;

    box.appendChild(card);

    setTimeout(() => {
      const qrEl = document.getElementById(`ticket-qr-${order.ticketId}`);
      if (qrEl) {
        new QRCode(qrEl, {
          text: JSON.stringify({ 
            e: 'HAVANNA_OBSESSION', 
            t: order.ticketId, 
            d: order.dni, 
            n: order.name,
            v: isVip 
          }),
          width: 100,
          height: 100,
          colorDark: "#1a1a1a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    }, 60);
  });
}

// ==========================================
// CONSULTA POR DNI
// ==========================================
function openLookupModal() {
  document.getElementById('modal-lookup').classList.remove('hidden');
  document.getElementById('lookup-response').classList.add('hidden');
  document.getElementById('lookup-dni-input').value = '';
}

function closeLookupModal() {
  document.getElementById('modal-lookup').classList.add('hidden');
}

function executeLookup() {
  const query = document.getElementById('lookup-dni-input').value.trim().toLowerCase();
  const out = document.getElementById('lookup-response');
  out.classList.remove('hidden');

  if (!query) {
    out.innerHTML = '<span style="color:#ef4444">Por favor ingresá tu DNI o Código de Orden.</span>';
    return;
  }

  const matchedOrders = cloudOrders.filter(o => 
    (o.dni && o.dni === query) || 
    (o.orderId && o.orderId.toLowerCase() === query) ||
    (o.ticketId && o.ticketId.toLowerCase() === query)
  );

  if (matchedOrders.length === 0) {
    out.innerHTML = '<span style="color:#8e8e99">No se encontraron tickets registrados con ese documento u orden.</span>';
    return;
  }

  const approved = matchedOrders.filter(o => o.status === 'approved');

  let html = `<div style="font-size:0.8rem; margin-bottom:0.6rem; color:#aaa">Entradas encontradas para DNI <strong>${query}</strong>: <strong>${matchedOrders.length}</strong></div>`;

  if (approved.length > 0) {
    html += `<button onclick="closeLookupModal(); openAllApprovedFromLookup('${query}')" class="btn-primary full-width" style="margin-bottom:1rem; padding:0.6rem; font-size:0.8rem">
      DESPLEGAR TODOS MIS TICKETS HABILITADOS (${approved.length})
    </button>`;
  }

  html += `<div class="lookup-tickets-list">`;
  matchedOrders.forEach((o) => {
    const isApproved = o.status === 'approved';
    const isUsed = o.used;
    const statusClass = isUsed ? 'used' : (isApproved ? 'approved' : 'pending');
    const statusLabel = isUsed ? 'INGRESÓ' : (isApproved ? 'HABILITADA' : 'PENDIENTE');
    const statusColor = isUsed ? '#9ca3af' : (isApproved ? '#34d399' : '#fbbf24');

    html += `
      <div class="lookup-ticket-card ${statusClass}">
        <div>
          <strong style="color:#fff; display:block; font-size:0.85rem">${o.ticketType}</strong>
          <small style="color:#8e8e99">${o.name} • ${o.ticketId}</small>
        </div>
        <div style="text-align:right">
          <span style="color:${statusColor}; font-weight:700; font-size:0.7rem; display:block">${statusLabel}</span>
          ${isApproved ? `
            <button onclick="closeLookupModal(); openSingleTicketFromLookup('${o.ticketId}')" style="background:transparent; border:none; color:var(--red-crimson); font-size:0.7rem; cursor:pointer; text-decoration:underline">
              Ver este QR
            </button>
          ` : ''}
        </div>
      </div>
    `;
  });
  html += `</div>`;

  out.innerHTML = html;
}

function openAllApprovedFromLookup(dniOrOrder) {
  const approved = cloudOrders.filter(o => 
    o.status === 'approved' && 
    ((o.dni && o.dni === dniOrOrder) || (o.orderId && o.orderId.toLowerCase() === dniOrOrder))
  );
  if (approved.length === 0) return;

  document.getElementById('modal-checkout').classList.remove('hidden');
  document.getElementById('co-step-form').classList.add('hidden');
  document.getElementById('co-step-transfer').classList.add('hidden');
  document.getElementById('co-step-pending').classList.add('hidden');
  renderMultipleTicketsUI(approved);
}

function openSingleTicketFromLookup(ticketId) {
  const order = cloudOrders.find(o => o.ticketId === ticketId);
  if (!order) return;

  document.getElementById('modal-checkout').classList.remove('hidden');
  document.getElementById('co-step-form').classList.add('hidden');
  document.getElementById('co-step-transfer').classList.add('hidden');
  document.getElementById('co-step-pending').classList.add('hidden');
  renderMultipleTicketsUI([order]);
}

function toggleMapModal() {
  document.getElementById('modal-map').classList.toggle('hidden');
}

// ==========================================
// PANEL STAFF (ACCESOS SECRETOS)
// ==========================================
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    openAdminModal();
  }
});

let secretTapCount = 0;
let secretTapTimer = null;
const secretTrigger = document.getElementById('secret-lookup-trigger');
if (secretTrigger) {
  secretTrigger.addEventListener('click', (e) => {
    secretTapCount++;
    clearTimeout(secretTapTimer);
    if (secretTapCount >= 4) {
      e.preventDefault();
      secretTapCount = 0;
      openAdminModal();
    } else {
      secretTapTimer = setTimeout(() => { secretTapCount = 0; }, 1200);
    }
  });
}

function openAdminModal() {
  document.getElementById('modal-admin-login').classList.remove('hidden');
  document.getElementById('admin-pin-input').value = '';
}

function closeAdminLoginModal() {
  document.getElementById('modal-admin-login').classList.add('hidden');
}

function authenticateAdmin() {
  const pin = document.getElementById('admin-pin-input').value;
  if (pin === CONFIG.adminPin) {
    closeAdminLoginModal();
    document.getElementById('modal-admin-dashboard').classList.remove('hidden');
    switchAdminTab('approvals');
    renderApprovalsList();
    updateMetrics();
  } else {
    alert('PIN incorrecto.');
  }
}

function closeAdminDashboard() {
  document.getElementById('modal-admin-dashboard').classList.add('hidden');
}

function switchAdminTab(tab) {
  const btnApp = document.getElementById('tab-btn-approvals');
  const btnDoor = document.getElementById('tab-btn-door');
  const viewApp = document.getElementById('adm-view-approvals');
  const viewDoor = document.getElementById('adm-view-door');

  if (tab === 'approvals') {
    btnApp.classList.add('active');
    btnDoor.classList.remove('active');
    viewApp.classList.remove('hidden');
    viewDoor.classList.add('hidden');
    renderApprovalsList();
  } else {
    btnDoor.classList.add('active');
    btnApp.classList.remove('active');
    viewDoor.classList.remove('hidden');
    viewApp.classList.add('hidden');
    renderDoorList();
  }
}

function updateMetrics() {
  const pending = cloudOrders.filter(o => o.status === 'pending').length;
  const approved = cloudOrders.filter(o => o.status === 'approved');
  const vips = approved.filter(o => o.ticketType && o.ticketType.includes('VIP')).length;
  const revenue = approved.reduce((acc, o) => acc + (o.amount || 0), 0);

  const elPending = document.getElementById('adm-metric-pending');
  const elApproved = document.getElementById('adm-metric-approved');
  const elVip = document.getElementById('adm-metric-vip');
  const elRevenue = document.getElementById('adm-metric-revenue');

  if (elPending) elPending.textContent = pending;
  if (elApproved) elApproved.textContent = approved.length;
  if (elVip) elVip.textContent = `${vips}/${CONFIG.maxVipStock}`;
  if (elRevenue) elRevenue.textContent = `$${revenue.toLocaleString('es-AR')}`;
}

function renderApprovalsList() {
  const list = document.getElementById('adm-pending-list');
  if (!list) return;
  list.innerHTML = '';

  const pendings = cloudOrders.filter(o => o.status === 'pending');

  if (pendings.length === 0) {
    list.innerHTML = '<div style="text-align:center; padding:3rem; color:#8e8e99; font-size:0.8rem">No hay pagos pendientes de revisión.</div>';
    return;
  }

  pendings.forEach(order => {
    const isVip = order.ticketType && order.ticketType.includes('VIP');
    const item = document.createElement('div');
    item.className = 'order-row-card';
    item.innerHTML = `
      <div>
        <div>
          <strong style="color:#fff">${order.orderId}</strong> — 
          <span style="color:${isVip ? 'var(--gold-vip)' : '#fff'}">${order.ticketType}</span> — 
          <strong style="color:#34d399">$${(order.amount || 0).toLocaleString('es-AR')}</strong>
        </div>
        <div style="color:#8e8e99; font-size:0.75rem; margin-top:3px">
          ${order.name} (DNI: ${order.dni}) • Tel: ${order.phone}
        </div>
      </div>
      <div>
        <button onclick="approveOrder('${order.firestoreId}')" class="btn-approve">Aprobar</button>
        <button onclick="rejectOrder('${order.firestoreId}')" class="btn-reject">Rechazar</button>
      </div>
    `;
    list.appendChild(item);
  });
}

async function approveOrder(id) {
  try {
    const { error } = await supabase.from('orders').update({ status: 'approved' }).eq('id', id);
    if (error) throw error;
  } catch (err) {
    alert("Error al aprobar: " + err.message);
  }
}

async function rejectOrder(id) {
  if (!confirm("¿Rechazar orden?")) return;
  try {
    const { error } = await supabase.from('orders').update({ status: 'rejected' }).eq('id', id);
    if (error) throw error;
  } catch (err) {
    alert("Error al rechazar: " + err.message);
  }
}

function renderDoorList() {
  const list = document.getElementById('adm-door-list');
  if (!list) return;
  list.innerHTML = '';

  const approved = cloudOrders.filter(o => o.status === 'approved');

  if (approved.length === 0) {
    list.innerHTML = '<div style="text-align:center; padding:2rem; color:#8e8e99; font-size:0.8rem">No hay asistentes habilitados en lista.</div>';
    return;
  }

  approved.forEach(order => {
    const isVip = order.ticketType && order.ticketType.includes('VIP');
    const row = document.createElement('div');
    row.className = `door-row ${order.used ? 'used' : ''}`;
    row.innerHTML = `
      <div>
        <strong style="color:${isVip ? 'var(--gold-vip)' : '#fff'}; display:block">${order.name} ${isVip ? '★ VIP' : ''}</strong>
        <span style="color:#8e8e99; font-size:0.75rem">DNI: ${order.dni} • ${order.ticketId}</span>
      </div>
      <div>
        ${order.used ? 
          '<span class="badge-used">INGRESÓ</span>' : 
          `<button onclick="manualCheckIn('${order.firestoreId}')" class="btn-approve" style="font-size:0.7rem">Marcar Ingreso</button>`
        }
      </div>
    `;
    list.appendChild(row);
  });
}

async function validateDoorCheckIn() {
  const rawInput = document.getElementById('door-input').value.trim();
  const msg = document.getElementById('door-msg');
  msg.className = 'door-feedback hidden';

  if (!rawInput) {
    msg.className = 'door-feedback error';
    msg.textContent = 'Ingresá un DNI o código de ticket.';
    return;
  }

  let query = rawInput;
  try {
    const parsed = JSON.parse(rawInput);
    if (parsed.t) query = parsed.t;
    else if (parsed.ticketId) query = parsed.ticketId;
    else if (parsed.d) query = parsed.d;
  } catch(e) {}

  const order = cloudOrders.find(o => 
    o.status === 'approved' && 
    (o.ticketId.toLowerCase() === query.toLowerCase() || o.dni === query || (o.orderId && o.orderId.toLowerCase() === query.toLowerCase()))
  );

  if (!order) {
    msg.className = 'door-feedback error';
    msg.innerHTML = '❌ TICKET INVÁLIDO O PAGO NO APROBADO.';
    return;
  }

  if (order.used) {
    msg.className = 'door-feedback used';
    msg.innerHTML = `⚠️ TICKET YA UTILIZADO POR ${order.name} (DNI ${order.dni}).`;
    return;
  }

  try {
    const { error } = await supabase.from('orders').update({ used: true }).eq('id', order.firestoreId);
    if (error) throw error;

    const isVip = order.ticketType && order.ticketType.includes('VIP');
    if (isVip) {
      msg.className = 'door-feedback vip-success';
      msg.innerHTML = `★ INGRESO VIP HABILITADO: ${order.name}<br>🍸 ENTREGAR CONSUMICIÓN GIN TONIC`;
    } else {
      msg.className = 'door-feedback success';
      msg.innerHTML = `✓ INGRESO PERMITIDO: ${order.name} [PISTA GENERAL]`;
    }
    document.getElementById('door-input').value = '';
  } catch (err) {
    alert("Error al validar: " + err.message);
  }
}

async function manualCheckIn(id) {
  try {
    const { error } = await supabase.from('orders').update({ used: true }).eq('id', id);
    if (error) throw error;
  } catch (err) {
    alert("Error al marcar ingreso: " + err.message);
  }
}