(function () {
  'use strict';

  // ==========================================
  // CONFIGURACION GENERAL & SUPABASE
  // ==========================================
  const SUPABASE_URL = 'https://anubyojemmaybrcmzqdo.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFudWJ5b2plbW1heWJyY216cWRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1OTg3NjUsImV4cCI6MjEwNjE3NDc2NX0.JH3fXRo8esF9s9G7sXNQr2L_5JPg2ppYrbOx26MDS-E';

  let client = null;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  const CONFIG = {
    adminPin: '2026',
    whatsappPhone: '5493794000000',
    maxVipStock: 50,
    spotifyUrl: 'https://open.spotify.com',
    wspGroupUrl: 'https://chat.whatsapp.com',
    instagramUrl: 'https://instagram.com/'
  };

  let cloudOrders = [];

  function cleanDni(val) {
    return String(val || '').replace(/\D/g, '').trim();
  }

  // ==========================================
  // FEEDBACK DE AUDIO EN PUERTA (SIN EMOJIS)
  // ==========================================
  function playAudioTone(type) {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'success') {
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
      } else if (type === 'vip') {
        osc.frequency.setValueAtTime(600, audioCtx.currentTime);
        osc.frequency.setValueAtTime(900, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.35);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
      }
    } catch (e) { }
  }

  // ==========================================
  // CUENTA REGRESIVA
  // ==========================================
  function initCountdown() {
    const eventDate = new Date('2026-10-31T23:59:59').getTime();
    function tick() {
      const diff = eventDate - new Date().getTime();
      if (diff > 0) {
        const d = document.getElementById('cd-days');
        const h = document.getElementById('cd-hours');
        const m = document.getElementById('cd-mins');
        const s = document.getElementById('cd-secs');
        if (d) d.textContent = String(Math.floor(diff / (1000 * 60 * 60 * 24))).padStart(2, '0');
        if (h) h.textContent = String(Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
        if (m) m.textContent = String(Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
        if (s) s.textContent = String(Math.floor((diff % (1000 * 60)) / 1000)).padStart(2, '0');
      }
    }
    setInterval(tick, 1000);
    tick();
  }

  // ==========================================
  // SINCRONIZACION SUPABASE
  // ==========================================
  async function fetchOrders() {
    if (!client) return;
    try {
      const { data, error } = await client
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
          dni: cleanDni(o.dni),
          phone: o.phone,
          email: o.email,
          ticketType: o.ticket_type,
          amount: Number(o.amount) || 0,
          status: o.status,
          used: o.used,
          createdAt: o.created_at
        }));

        updateMetrics();
        renderApprovalsList();
        renderDoorList();
        checkVipAvailability();

        if (activeCreatedOrders.length > 0) {
          const curId = activeCreatedOrders[0].orderId;
          const fresh = cloudOrders.filter(o => o.orderId === curId);
          if (fresh.some(o => o.status === 'approved')) {
            const pendScreen = document.getElementById('co-step-pending');
            if (pendScreen && !pendScreen.classList.contains('hidden')) {
              pendScreen.classList.add('hidden');
              renderMultipleTicketsUI(fresh.filter(o => o.status === 'approved'));
            }
          }
        }
      }
    } catch (err) {
      console.error("Error sincronizacion Supabase:", err);
    }
  }

  function initRealtime() {
    if (!client) return;
    fetchOrders();

    client
      .channel('schema-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        fetchOrders();
      })
      .subscribe();
  }

  function checkVipAvailability() {
    const vipCount = cloudOrders.filter(o =>
      o.ticketType && o.ticketType.includes('VIP') && o.status === 'approved'
    ).length;

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
  // CHECKOUT
  // ==========================================
  let activePlan = { name: '', unitPrice: 0 };
  let activeCreatedOrders = [];

  function openCheckout(name, price) {
    activePlan = { name, unitPrice: price };

    document.getElementById('co-ticket-name').textContent = name;
    document.getElementById('co-unit-price').textContent = `$${price.toLocaleString('es-AR')} ARS`;

    const selectQty = document.getElementById('cust-qty');
    if (selectQty) {
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
    }

    updateCheckoutTotal();
    document.getElementById('co-step-form').classList.remove('hidden');
    document.getElementById('co-step-transfer').classList.add('hidden');
    document.getElementById('co-step-pending').classList.add('hidden');
    document.getElementById('co-step-ticket').classList.add('hidden');
    document.getElementById('orderForm').reset();
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

    const btnSubmit = e.target.querySelector('button[type="submit"]');
    const name = document.getElementById('cust-name').value.trim();
    const dni = cleanDni(document.getElementById('cust-dni').value);
    const phone = document.getElementById('cust-phone').value.trim();
    const email = document.getElementById('cust-email').value.trim();
    const qty = parseInt(document.getElementById('cust-qty').value) || 1;

    if (!dni || dni.length < 7 || dni.length > 9) {
      alert("Ingrese un numero de DNI valido (entre 7 y 9 digitos).");
      return;
    }

    const pendingOrders = cloudOrders.filter(o => o.dni === dni && o.status === 'pending');
    if (pendingOrders.length >= 2) {
      alert("Ya registra ordenes pendientes para este DNI. Aguarde la validacion o envie su comprobante por WhatsApp.");
      return;
    }

    if (qty > 4 || qty < 1) {
      alert("Limite maximo: 4 entradas por transaccion.");
      return;
    }

    if (activePlan.name.includes('VIP')) {
      const vipApprovedCount = cloudOrders.filter(o => o.ticketType && o.ticketType.includes('VIP') && o.status === 'approved').length;
      if (vipApprovedCount + qty > CONFIG.maxVipStock) {
        alert(`Cupos VIP insuficientes. Restantes: ${CONFIG.maxVipStock - vipApprovedCount}.`);
        return;
      }
    }

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.textContent = "GENERANDO REGISTRO...";
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
        name: qty > 1 ? `${name} [${i + 1}/${qty}]` : name,
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
      const { data, error } = await client.from('orders').insert(rowsToInsert).select();
      if (error) throw error;

      activeCreatedOrders = data.map(o => ({
        firestoreId: o.id,
        orderId: o.order_id,
        ticketId: o.ticket_id,
        name: o.name,
        buyerName: o.buyer_name,
        dni: cleanDni(o.dni),
        amount: Number(o.amount),
        ticketType: o.ticket_type
      }));

      document.getElementById('co-step-form').classList.add('hidden');
      document.getElementById('transfer-order-code').textContent = sharedOrderId;
      document.getElementById('co-step-transfer').classList.remove('hidden');
    } catch (err) {
      alert("Error en el registro: " + err.message);
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.textContent = "CONTINUAR A TRANSFERENCIA //➔";
      }
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

    const text = `Hola Alejo. Realice la transferencia para HAVANNA CLUB // HALLOWEEN OBSESSION 2026.%0A%0A` +
      `• Orden: ${o.orderId} (${qty} ticket${qty > 1 ? 's' : ''})%0A` +
      `• Titular: ${o.buyerName || o.name}%0A` +
      `• DNI: ${o.dni}%0A` +
      `• Sector: ${o.ticketType}%0A` +
      `• Monto: $${total.toLocaleString('es-AR')} ARS%0A%0A` +
      `Adjunto comprobante para validacion en sistema.`;

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
      alert('La orden sigue en revision.');
    }
  }

  // ==========================================
  // RENDER TICKETS (ESTILO EDITORIAL VINTAGE)
  // ==========================================
  function renderMultipleTicketsUI(ordersList) {
    document.getElementById('co-step-ticket').classList.remove('hidden');
    const box = document.getElementById('ticket-render-box');
    if (!box) return;
    box.innerHTML = '';

    ordersList.forEach(order => {
      const isVip = order.ticketType && order.ticketType.includes('VIP');
      const cardWrapper = document.createElement('div');
      cardWrapper.style.marginBottom = "2rem";

      const card = document.createElement('div');
      card.id = `ticket-card-${order.ticketId}`;
      card.className = `retro-obsession-ticket ${isVip ? 'theme-vip-yellow' : 'theme-general-red'}`;
      card.innerHTML = `
        <div class="ticket-watermark">HAVANNA OFFICIAL // OBSESSION 2026 // NO DUPLICAR</div>

        <div class="retro-ticket-body">
          <div class="retro-banner-head">
            <span class="retro-sub">SPARK THE MIDDLE AND BREAK IT IN HALF!</span>
            <h2 class="retro-title">${isVip ? 'VIP OBSESSION' : 'ONE WISH WILLOW'}</h2>
            <div class="retro-motto">HAVANNA CLUB • ITÁ IBATÉ // HALLOWEEN 2026</div>
          </div>

          <div class="retro-fields-grid">
            <div class="field-box">
              <label>TITULAR</label>
              <div class="val-text">${order.name}</div>
            </div>
            <div class="field-box">
              <label>DOCUMENTO NACIONAL [DNI]</label>
              <div class="val-text">${order.dni}</div>
            </div>
            <div class="field-box">
              <label>SECTOR</label>
              <div class="val-text">${order.ticketType.toUpperCase()}</div>
            </div>
            <div class="field-box">
              <label>FECHA & HORA</label>
              <div class="val-text">31 OCTUBRE // 23:59 HS</div>
            </div>
          </div>

          <div class="retro-bottom-badge">
            ${isVip ? '★ INCLUYE 1 CONSUMICIÓN GIN TONIC EN BALCÓN ★' : 'AMAZE YOUR FRIENDS! • YOU ONLY GET ONE WISH'}
          </div>
        </div>

        <div class="retro-stub">
          <div class="stub-notch notch-top"></div>
          <div class="stub-notch notch-bottom"></div>
          <div class="stub-qr-container">
            <div id="ticket-qr-${order.ticketId}"></div>
          </div>
          <div class="stub-code-badge">${order.ticketId}</div>
          <div class="stub-notice">CONTROL EN PUERTA</div>
        </div>
      `;

      const btnGroup = document.createElement('div');
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '8px';
      btnGroup.style.marginTop = '10px';

      const btnDownload = document.createElement('button');
      btnDownload.className = 'btn-download-ticket';
      btnDownload.style.flex = '1';
      btnDownload.innerHTML = `Descargar Ticket (${order.ticketId})`;
      btnDownload.onclick = () => downloadTicketAsImage(order.ticketId, order.name);

      const btnShare = document.createElement('button');
      btnShare.className = 'btn-download-ticket';
      btnShare.style.flex = '1';
      btnShare.style.background = '#15803d';
      btnShare.innerHTML = `Compartir Datos`;
      btnShare.onclick = () => {
        const shareMsg = `Entrada oficial Havanna Club Halloween 2026 para ${order.name} (DNI ${order.dni}). Acceso con DNI en https://alejolegal.com/`;
        window.open(`https://wa.me/?text=${encodeURIComponent(shareMsg)}`, '_blank');
      };

      btnGroup.appendChild(btnDownload);
      btnGroup.appendChild(btnShare);

      cardWrapper.appendChild(card);
      cardWrapper.appendChild(btnGroup);
      box.appendChild(cardWrapper);

      setTimeout(() => {
        const qrEl = document.getElementById(`ticket-qr-${order.ticketId}`);
        if (qrEl && typeof QRCode !== 'undefined') {
          new QRCode(qrEl, {
            text: JSON.stringify({
              t: order.ticketId,
              d: order.dni,
              n: order.name,
              s: order.ticketType
            }),
            width: 100,
            height: 100,
            colorDark: isVip ? "#4d3800" : "#5c1010",
            colorLight: "#faf6ee",
            correctLevel: QRCode.CorrectLevel.M
          });
        }
      }, 60);
    });
  }

  function downloadTicketAsImage(ticketId, holderName) {
    const el = document.getElementById(`ticket-card-${ticketId}`);
    if (!el || typeof html2canvas === 'undefined') {
      alert("Procesando ticket...");
      return;
    }
    html2canvas(el, { backgroundColor: '#090a0f', scale: 2 }).then(canvas => {
      const link = document.createElement('a');
      link.download = `Havanna_Ticket_${ticketId}_${holderName.replace(/\s+/g, '_')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
  }

  // ==========================================
  // CONSULTA DNI CLIENTE
  // ==========================================
  function openLookupModal() {
    document.getElementById('modal-lookup').classList.remove('hidden');
    document.getElementById('lookup-response').classList.add('hidden');
    document.getElementById('lookup-dni-input').value = '';
  }

  function closeLookupModal() {
    document.getElementById('modal-lookup').classList.add('hidden');
  }

  async function executeLookup() {
    const rawVal = document.getElementById('lookup-dni-input').value.trim();
    const cleanNum = cleanDni(rawVal);
    const out = document.getElementById('lookup-response');
    out.classList.remove('hidden');

    if (!rawVal) {
      out.innerHTML = '<span style="color:#ef4444">Ingrese su DNI o Referencia de Orden.</span>';
      return;
    }

    out.innerHTML = '<span style="color:#8e8e99">Buscando registros...</span>';
    await fetchOrders();

    const matchedOrders = cloudOrders.filter(o =>
      (cleanNum && o.dni === cleanNum) ||
      (o.orderId && o.orderId.toLowerCase() === rawVal.toLowerCase()) ||
      (o.ticketId && o.ticketId.toLowerCase() === rawVal.toLowerCase())
    );

    if (matchedOrders.length === 0) {
      out.innerHTML = `<span style="color:#8e8e99">No se registran tickets bajo <strong>${rawVal}</strong>.</span>`;
      return;
    }

    const approved = matchedOrders.filter(o => o.status === 'approved');

    let html = `<div style="font-size:0.8rem; margin-bottom:0.8rem; color:#aaa">Entradas asociadas: <strong>${matchedOrders.length}</strong></div>`;

    if (approved.length > 0) {
      html += `<button onclick="window.openAllApprovedFromLookup('${cleanNum || rawVal}')" class="btn-primary full-width" style="margin-bottom:1rem; padding:0.7rem; font-size:0.8rem">
        DESPLEGAR TODAS LAS ENTRADAS HABILITADAS (${approved.length})
      </button>`;
    }

    html += `<div class="lookup-tickets-list">`;
    matchedOrders.forEach((o) => {
      const isApproved = o.status === 'approved';
      const isUsed = o.used;
      const statusLabel = isUsed ? 'INGRESADO' : (isApproved ? 'HABILITADO' : 'EN REVISION');
      const statusColor = isUsed ? '#9ca3af' : (isApproved ? '#34d399' : '#fbbf24');

      html += `
        <div class="lookup-ticket-card" style="display:flex; justify-content:space-between; align-items:center; padding:12px; margin-bottom:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;">
          <div>
            <strong style="color:#fff; display:block; font-size:0.88rem">${o.ticketType}</strong>
            <small style="color:#8e8e99">${o.name} • ${o.ticketId}</small>
          </div>
          <div style="text-align:right">
            <span style="color:${statusColor}; font-weight:700; font-size:0.72rem; display:block; margin-bottom:4px">${statusLabel}</span>
            ${isApproved ? `
              <button onclick="window.openSingleTicketFromLookup('${o.ticketId}')" class="btn-view-qr">
                Ver QR //➔
              </button>
            ` : ''}
          </div>
        </div>
      `;
    });
    html += `</div>`;
    out.innerHTML = html;
  }

  function openAllApprovedFromLookup(query) {
    closeLookupModal();
    const approved = cloudOrders.filter(o =>
      o.status === 'approved' &&
      (o.dni === query || (o.orderId && o.orderId.toLowerCase() === query.toLowerCase()))
    );
    if (approved.length === 0) return;

    document.getElementById('modal-checkout').classList.remove('hidden');
    document.getElementById('co-step-form').classList.add('hidden');
    document.getElementById('co-step-transfer').classList.add('hidden');
    document.getElementById('co-step-pending').classList.add('hidden');
    renderMultipleTicketsUI(approved);
  }

  function openSingleTicketFromLookup(ticketId) {
    closeLookupModal();
    const order = cloudOrders.find(o => o.ticketId === ticketId);
    if (!order) return;

    document.getElementById('modal-checkout').classList.remove('hidden');
    document.getElementById('co-step-form').classList.add('hidden');
    document.getElementById('co-step-transfer').classList.add('hidden');
    document.getElementById('co-step-pending').classList.add('hidden');
    renderMultipleTicketsUI([order]);
  }

  // ==========================================
  // PANEL STAFF
  // ==========================================
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      openAdminModal();
    }
  });

  let staffTapCount = 0;
  let staffTapTimer = null;
  const staffTrigger = document.getElementById('secret-admin-trigger');

  if (staffTrigger) {
    staffTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      staffTapCount++;
      clearTimeout(staffTapTimer);

      if (staffTapCount >= 3) {
        staffTapCount = 0;
        openAdminModal();
      } else {
        staffTapTimer = setTimeout(() => {
          staffTapCount = 0;
        }, 900);
      }
    });
  }

  function openAdminModal() {
    const modalLogin = document.getElementById('modal-admin-login');
    const pinInput = document.getElementById('admin-pin-input');
    if (modalLogin) modalLogin.classList.remove('hidden');
    if (pinInput) pinInput.value = '';
  }

  function closeAdminLoginModal() {
    const modalLogin = document.getElementById('modal-admin-login');
    if (modalLogin) modalLogin.classList.add('hidden');
  }

  function authenticateAdmin() {
    const pinInput = document.getElementById('admin-pin-input');
    const pin = pinInput ? pinInput.value.trim() : '';

    if (pin === CONFIG.adminPin) {
      closeAdminLoginModal();
      const modalDash = document.getElementById('modal-admin-dashboard');
      if (modalDash) modalDash.classList.remove('hidden');
      switchAdminTab('approvals');
      renderApprovalsList();
      updateMetrics();
    } else {
      alert('PIN invalido.');
    }
  }

  function closeAdminDashboard() {
    stopQrCameraScanner();
    const modalDash = document.getElementById('modal-admin-dashboard');
    if (modalDash) modalDash.classList.add('hidden');
  }

  function switchAdminTab(tab) {
    const btnApp = document.getElementById('tab-btn-approvals');
    const btnDoor = document.getElementById('tab-btn-door');
    const viewApp = document.getElementById('adm-view-approvals');
    const viewDoor = document.getElementById('adm-view-door');

    if (tab === 'approvals') {
      stopQrCameraScanner();
      btnApp?.classList.add('active');
      btnDoor?.classList.remove('active');
      viewApp?.classList.remove('hidden');
      viewDoor?.classList.add('hidden');
      renderApprovalsList();
    } else {
      btnDoor?.classList.add('active');
      btnApp?.classList.remove('active');
      viewDoor?.classList.remove('hidden');
      viewApp?.classList.add('hidden');
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
      list.innerHTML = '<div style="text-align:center; padding:3rem; color:#8e8e99; font-size:0.8rem">No hay ordenes pendientes de revision.</div>';
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
            <span style="color:${isVip ? '#eab308' : '#fff'}">${order.ticketType}</span> — 
            <strong style="color:#34d399">$${(order.amount || 0).toLocaleString('es-AR')}</strong>
          </div>
          <div style="color:#8e8e99; font-size:0.75rem; margin-top:3px">
            ${order.name} (DNI: ${order.dni}) • Tel: ${order.phone}
          </div>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button onclick="window.approveOrderAndNotify('${order.firestoreId}', '${order.phone}', '${order.name}')" class="btn-approve" title="Aprobar">[OK] Aprobar</button>
          <button onclick="window.rejectOrder('${order.firestoreId}')" class="btn-reject">[X] Rechazar</button>
        </div>
      `;
      list.appendChild(item);
    });
  }

  async function approveOrderAndNotify(id, phone, name) {
    try {
      const { error } = await client.from('orders').update({ status: 'approved' }).eq('id', id);
      if (error) throw error;
      await fetchOrders();

      const cleanPhone = String(phone || '').replace(/\D/g, '');
      if (cleanPhone) {
        const msg = `Hola ${name}. Tu pago para HAVANNA OBSESSION 2026 fue APROBADO.%0A%0A` +
          `Podes consultar tus tickets habilitados ingresando tu DNI en:%0A` +
          `https://alejolegal.com/%0A%0A` +
          `Ingreso obligatorio con DNI fisico en mano.`;
        window.open(`https://wa.me/${cleanPhone.startsWith('54') ? cleanPhone : '54' + cleanPhone}?text=${msg}`, '_blank');
      }
    } catch (err) {
      alert("Error al aprobar: " + err.message);
    }
  }

  async function rejectOrder(id) {
    if (!confirm("Confirmar rechazo de orden?")) return;
    try {
      const { error } = await client.from('orders').update({ status: 'rejected' }).eq('id', id);
      if (error) throw error;
      await fetchOrders();
    } catch (err) {
      alert("Error al rechazar: " + err.message);
    }
  }

  // ==========================================
  // CONTROL EN PUERTA (INTELIGENTE MULTI-TICKET)
  // ==========================================
  function handleDoorInputKey(e) {
    if (e.key === 'Enter') {
      validateDoorCheckIn();
    }
  }

  function handleDoorSearchInput(val) {
    if (val.trim().length >= 4) {
      validateDoorCheckIn();
    }
  }

  async function processDoorVerification(identifier) {
    const msg = document.getElementById('door-msg');
    const panel = document.getElementById('door-verification-panel');
    msg.className = 'door-feedback hidden';
    panel.className = 'hidden';
    panel.innerHTML = '';

    if (!identifier) {
      msg.className = 'door-feedback error';
      msg.textContent = 'Ingrese DNI o escanee un Ticket QR.';
      playAudioTone('error');
      return;
    }

    let query = identifier;
    let targetTicketId = null;

    try {
      const parsed = JSON.parse(identifier);
      if (parsed.t) targetTicketId = parsed.t;
      if (parsed.d) query = parsed.d;
      else if (parsed.ticketId) targetTicketId = parsed.ticketId;
    } catch (e) { }

    const cleanQ = cleanDni(query);

    // Búsqueda de todas las órdenes aprobadas asociadas al DNI, OrderId o TicketId
    const matchedTickets = cloudOrders.filter(o =>
      o.status === 'approved' && (
        (cleanQ && o.dni === cleanQ) ||
        (targetTicketId && o.ticketId.toLowerCase() === targetTicketId.toLowerCase()) ||
        (o.ticketId.toLowerCase() === query.toLowerCase()) ||
        (o.orderId && o.orderId.toLowerCase() === query.toLowerCase())
      )
    );

    if (matchedTickets.length === 0) {
      msg.className = 'door-feedback error';
      msg.innerHTML = `[ACCESO DENEGADO] No existen tickets aprobados para "${identifier}".`;
      playAudioTone('error');
      return;
    }

    const first = matchedTickets[0];
    // Traemos TODAS las compras del titular de ese DNI (incluso si escaneó solo un ticket)
    const allUserTickets = cloudOrders.filter(o => o.status === 'approved' && o.dni === first.dni);
    const pendingToEnter = allUserTickets.filter(o => !o.used);
    const hasVip = allUserTickets.some(o => o.ticketType && o.ticketType.includes('VIP'));

    panel.className = 'door-multi-panel';
    panel.innerHTML = `
      <div class="panel-header-info">
        <div>
          <span class="label-sub">TITULAR REGISTRADO</span>
          <h3 class="holder-name">${first.name}</h3>
          <span class="holder-dni">DNI: <strong>${first.dni}</strong></span>
        </div>
        <div style="text-align:right;">
          <span class="count-badge">${pendingToEnter.length} / ${allUserTickets.length} DISPONIBLES</span>
          ${hasVip ? '<span class="badge-vip-pill">[INCLUYE VIP]</span>' : ''}
        </div>
      </div>

      ${pendingToEnter.length > 1 ? `
        <button onclick="window.checkInAllPending('${first.dni}')" class="btn-checkin-all">
          [+] INGRESAR TODAS LAS ENTRADAS PENDIENTES (${pendingToEnter.length})
        </button>
      ` : ''}

      <div class="tickets-breakdown-list">
        ${allUserTickets.map(t => `
          <div class="breakdown-item ${t.used ? 'item-used' : 'item-active'}">
            <div>
              <span class="tk-type">${t.ticketType}</span>
              <span class="tk-id">${t.ticketId}${t.used ? '(INGRESADO)' : '(HABILITADO)'}</span>
            </div>
            <div>
              ${t.used ?
        '<span class="status-used-tag">INGRESADO</span>' :
        `<button onclick="window.manualCheckIn('${t.firestoreId}')" class="btn-checkin-single">INGRESAR //➔</button>`
      }
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Si escaneó un QR específico y esa entrada está lista, la ingresa de una
    if (targetTicketId) {
      const specific = allUserTickets.find(t => t.ticketId === targetTicketId);
      if (specific && !specific.used) {
        await manualCheckIn(specific.firestoreId);
      } else if (specific && specific.used) {
        playAudioTone('error');
      }
    } else {
      playAudioTone(hasVip ? 'vip' : 'success');
    }
  }

  async function checkInAllPending(dni) {
    const pendings = cloudOrders.filter(o => o.status === 'approved' && o.dni === dni && !o.used);
    for (const t of pendings) {
      await client.from('orders').update({ used: true }).eq('id', t.firestoreId);
    }
    playAudioTone('success');
    await fetchOrders();
    processDoorVerification(dni);
  }

  async function validateDoorCheckIn() {
    const rawInput = document.getElementById('door-input').value.trim();
    processDoorVerification(rawInput);
  }

  async function manualCheckIn(id) {
    try {
      const { error } = await client.from('orders').update({ used: true }).eq('id', id);
      if (error) throw error;
      playAudioTone('success');
      await fetchOrders();

      const updated = cloudOrders.find(o => o.firestoreId === id);
      if (updated) {
        processDoorVerification(updated.dni);
      }
    } catch (err) {
      alert("Error de registro: " + err.message);
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
          <strong style="color:${isVip ? '#eab308' : '#fff'}; display:block">${order.name} ${isVip ? '[VIP]' : ''}</strong>
          <span style="color:#8e8e99; font-size:0.75rem">DNI: ${order.dni} • ${order.ticketId}</span>
        </div>
        <div>
          ${order.used ?
          '<span class="badge-used">INGRESADO</span>' :
          `<button onclick="window.manualCheckIn('${order.firestoreId}')" class="btn-approve" style="font-size:0.7rem">Marcar Ingreso</button>`
        }
        </div>
      `;
      list.appendChild(row);
    });
  }

  // ==========================================
  // ESCANER CAMARA
  // ==========================================
  let html5QrScanner = null;

  function toggleQrCameraScanner() {
    const qrBox = document.getElementById('qr-reader');
    const btn = document.getElementById('btn-toggle-cam');

    if (html5QrScanner) {
      stopQrCameraScanner();
      return;
    }

    if (typeof Html5Qrcode === 'undefined') {
      alert("Libreria de escaneo no disponible.");
      return;
    }

    qrBox.classList.remove('hidden');
    btn.textContent = "[X] DETENER CAMARA";
    btn.style.borderColor = "#ef4444";
    btn.style.color = "#ef4444";

    html5QrScanner = new Html5Qrcode("qr-reader");
    html5QrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => {
        processDoorVerification(decodedText);
      },
      () => { }
    ).catch(err => {
      alert("Permiso de camara denegado: " + err);
      stopQrCameraScanner();
    });
  }

  function stopQrCameraScanner() {
    if (html5QrScanner) {
      html5QrScanner.stop().then(() => {
        html5QrScanner.clear();
        html5QrScanner = null;
        const qrBox = document.getElementById('qr-reader');
        if (qrBox) qrBox.classList.add('hidden');
        const btn = document.getElementById('btn-toggle-cam');
        if (btn) {
          btn.textContent = "[CAMARA] ACTIVAR ESCANER";
          btn.style.borderColor = "#f59e0b";
          btn.style.color = "#f59e0b";
        }
      }).catch(() => {
        html5QrScanner = null;
      });
    }
  }

  // ==========================================
  // EXPORTAR PDF
  // ==========================================
  function exportDoorListPDF() {
    if (typeof window.jspdf === 'undefined') {
      alert("Cargando modulo PDF...");
      return;
    }

    const approved = cloudOrders
      .filter(o => o.status === 'approved')
      .sort((a, b) => a.name.localeCompare(b.name));

    if (approved.length === 0) {
      alert("No hay tickets aprobados para exportar.");
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('p', 'mm', 'a4');

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("HAVANNA CLUB // HALLOWEEN OBSESSION 2026", 14, 15);
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(`PLANILLA DE CONTROL EN PUERTA • TOTAL: ${approved.length} ASISTENTES`, 14, 21);
    doc.text(`Fecha emision: ${new Date().toLocaleString('es-AR')}`, 14, 26);
    doc.line(14, 28, 196, 28);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    let y = 34;
    doc.text("N", 14, y);
    doc.text("TITULAR", 22, y);
    doc.text("DNI", 85, y);
    doc.text("TICKET ID", 115, y);
    doc.text("SECTOR", 145, y);
    doc.text("CHECK", 185, y);
    doc.line(14, y + 2, 196, y + 2);

    y += 7;
    doc.setFont("helvetica", "normal");

    approved.forEach((o, index) => {
      if (y > 280) {
        doc.addPage();
        y = 15;
        doc.setFont("helvetica", "bold");
        doc.text("N", 14, y);
        doc.text("TITULAR", 22, y);
        doc.text("DNI", 85, y);
        doc.text("TICKET ID", 115, y);
        doc.text("SECTOR", 145, y);
        doc.text("CHECK", 185, y);
        doc.line(14, y + 2, 196, y + 2);
        y += 7;
        doc.setFont("helvetica", "normal");
      }

      const isVip = o.ticketType && o.ticketType.includes('VIP');
      doc.text(String(index + 1), 14, y);
      doc.text(o.name.substring(0, 30), 22, y);
      doc.text(o.dni, 85, y);
      doc.text(o.ticketId, 115, y);
      doc.text(isVip ? "VIP + GIN" : "GENERAL", 145, y);
      doc.rect(185, y - 3.5, 4, 4);

      y += 6;
    });

    doc.save(`Havanna_Puerta_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  // EXPOSICION GLOBAL
  window.openCheckout = openCheckout;
  window.closeCheckout = closeCheckout;
  window.updateCheckoutTotal = updateCheckoutTotal;
  window.handleOrderSubmit = handleOrderSubmit;
  window.copyAlias = copyAlias;
  window.sendWhatsAppProof = sendWhatsAppProof;
  window.checkStatusFromCurrent = checkStatusFromCurrent;
  window.openLookupModal = openLookupModal;
  window.closeLookupModal = closeLookupModal;
  window.executeLookup = executeLookup;
  window.openAllApprovedFromLookup = openAllApprovedFromLookup;
  window.openSingleTicketFromLookup = openSingleTicketFromLookup;
  window.toggleMapModal = () => document.getElementById('modal-map').classList.toggle('hidden');
  window.openAdminModal = openAdminModal;
  window.closeAdminLoginModal = closeAdminLoginModal;
  window.authenticateAdmin = authenticateAdmin;
  window.closeAdminDashboard = closeAdminDashboard;
  window.switchAdminTab = switchAdminTab;
  window.approveOrderAndNotify = approveOrderAndNotify;
  window.rejectOrder = rejectOrder;
  window.validateDoorCheckIn = validateDoorCheckIn;
  window.manualCheckIn = manualCheckIn;
  window.checkInAllPending = checkInAllPending;
  window.toggleQrCameraScanner = toggleQrCameraScanner;
  window.handleDoorInputKey = handleDoorInputKey;
  window.handleDoorSearchInput = handleDoorSearchInput;
  window.exportDoorListPDF = exportDoorListPDF;

  function start() {
    initCountdown();
    initRealtime();

    const spLink = document.getElementById('btn-spotify-link');
    const wspLink = document.getElementById('btn-wsp-group-link');
    if (spLink) spLink.href = CONFIG.spotifyUrl;
    if (wspLink) wspLink.href = CONFIG.wspGroupUrl;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
