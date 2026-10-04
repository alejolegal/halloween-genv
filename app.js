(function () {
  'use strict';

  // ==========================================
  // CONFIGURACIÓN GENERAL & SUPABASE
  // ==========================================
  const SUPABASE_URL = 'https://anubyojemmaybrcmzqdo.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFudWJ5b2plbW1heWJyY216cWRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1OTg3NjUsImV4cCI6MjEwNjE3NDc2NX0.JH3fXRo8esF9s9G7sXNQr2L_5JPg2ppYrbOx26MDS-E';

  let client = null;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }

  const CONFIG = {
    adminPin: '2026',
    whatsappPhone: '5493794000000', // Modificá acá con tu WhatsApp
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
  // SINCRONIZACIÓN Y TIEMPO REAL
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

        // Actualización dinámica si el usuario tiene abierta la vista de espera o tickets
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
      console.error("Error al sincronizar Supabase:", err);
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
    // FILTRO: Solo resta cupos si la compra está aprobada
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
  // CHECKOUT MULTI-CANTIDAD
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

    // 1. Validación de DNI
    if (!dni || dni.length < 7 || dni.length > 9) {
      alert("Por favor ingresá un número de DNI válido (entre 7 y 9 dígitos).");
      return;
    }

    // 2. FILTRO ANTI-SPAM: Máximo 2 órdenes pendientes por DNI
    const pendingOrders = cloudOrders.filter(o => o.dni === dni && o.status === 'pending');
    if (pendingOrders.length >= 2) {
      alert("Ya registrás compras pendientes de validación para este DNI. Por favor enviá el comprobante de pago por WhatsApp o aguardá a que el staff apruebe tu orden.");
      return;
    }

    // 3. TOPE MÁXIMO DE TICKETS
    if (qty > 4 || qty < 1) {
      alert("El límite máximo permitido es de 4 entradas por compra.");
      return;
    }

    // 4. Control de cupos VIP sobre compras aprobadas
    if (activePlan.name.includes('VIP')) {
      const vipApprovedCount = cloudOrders.filter(o => o.ticketType && o.ticketType.includes('VIP') && o.status === 'approved').length;
      if (vipApprovedCount + qty > CONFIG.maxVipStock) {
        alert(`Solo quedan ${CONFIG.maxVipStock - vipApprovedCount} cupos VIP disponibles.`);
        return;
      }
    }

    // Bloqueo del botón para evitar envíos duplicados por doble clic
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.textContent = "GENERANDO ORDEN...";
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
      alert("Error al registrar la orden: " + err.message);
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
  // RENDERIZADO Y DESCARGA DE TICKETS
  // ==========================================
  function renderMultipleTicketsUI(ordersList) {
    document.getElementById('co-step-ticket').classList.remove('hidden');
    const box = document.getElementById('ticket-render-box');
    if (!box) return;
    box.innerHTML = '';

    if (typeof confetti === 'function') {
      confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } });
    }

    if (ordersList.length > 1) {
      const notice = document.createElement('div');
      notice.style.cssText = "font-family:var(--font-mono); font-size:0.75rem; color:#34d399; margin-bottom:1rem; text-align:center;";
      notice.innerHTML = `✓ Se encontraron <strong>${ordersList.length} entradas</strong> asociadas:`;
      box.appendChild(notice);
    }

    ordersList.forEach(order => {
      const isVip = order.ticketType && order.ticketType.includes('VIP');
      const cardWrapper = document.createElement('div');
      cardWrapper.style.marginBottom = "1.5rem";

      const card = document.createElement('div');
      card.id = `ticket-card-${order.ticketId}`;
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

          ${isVip ? `<div class="ow-vip-seal">★ INCLUYE 1 CONSUMICIÓN GIN TONIC ★</div>` : ''}
        </div>

        <div class="ticket-stub">
          <div class="stub-qr-box">
            <div id="ticket-qr-${order.ticketId}"></div>
          </div>
          <div class="stub-id">${order.ticketId}</div>
        </div>
      `;

      const btnDownload = document.createElement('button');
      btnDownload.className = 'btn-download-ticket';
      btnDownload.innerHTML = `💾 Descargar este Ticket (${order.ticketId})`;
      btnDownload.onclick = () => downloadTicketAsImage(order.ticketId, order.name);

      cardWrapper.appendChild(card);
      cardWrapper.appendChild(btnDownload);
      box.appendChild(cardWrapper);

      setTimeout(() => {
        const qrEl = document.getElementById(`ticket-qr-${order.ticketId}`);
        if (qrEl && typeof QRCode !== 'undefined') {
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

  function downloadTicketAsImage(ticketId, holderName) {
    const el = document.getElementById(`ticket-card-${ticketId}`);
    if (!el || typeof html2canvas === 'undefined') {
      alert("Preparando ticket para descarga...");
      return;
    }
    html2canvas(el, { backgroundColor: '#090a0f', scale: 2 }).then(canvas => {
      const link = document.createElement('a');
      link.download = `Ticket-Havanna-${ticketId}-${holderName.replace(/\s+/g, '_')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
  }

  // ==========================================
  // CONSULTA POR DNI (DIRECTA Y ROBUSTA)
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
      out.innerHTML = '<span style="color:#ef4444">Por favor ingresá tu DNI o Código de Orden.</span>';
      return;
    }

    out.innerHTML = '<span style="color:#8e8e99">Buscando entradas en el sistema...</span>';

    // Aseguramos sincronización fresca desde Supabase
    await fetchOrders();

    const matchedOrders = cloudOrders.filter(o =>
      (cleanNum && o.dni === cleanNum) ||
      (o.orderId && o.orderId.toLowerCase() === rawVal.toLowerCase()) ||
      (o.ticketId && o.ticketId.toLowerCase() === rawVal.toLowerCase())
    );

    if (matchedOrders.length === 0) {
      out.innerHTML = `<span style="color:#8e8e99">No se encontraron tickets para el DNI/Orden <strong>${rawVal}</strong>. Verificá que esté escrito correctamente.</span>`;
      return;
    }

    const approved = matchedOrders.filter(o => o.status === 'approved');

    let html = `<div style="font-size:0.8rem; margin-bottom:0.8rem; color:#aaa">Entradas registradas para este documento: <strong>${matchedOrders.length}</strong></div>`;

    if (approved.length > 0) {
      html += `<button onclick="window.openAllApprovedFromLookup('${cleanNum || rawVal}')" class="btn-primary full-width" style="margin-bottom:1rem; padding:0.7rem; font-size:0.8rem">
        DESPLEGAR TODAS MIS ENTRADAS HABILITADAS (${approved.length})
      </button>`;
    }

    html += `<div class="lookup-tickets-list">`;
    matchedOrders.forEach((o) => {
      const isApproved = o.status === 'approved';
      const isUsed = o.used;
      const statusLabel = isUsed ? 'INGRESÓ' : (isApproved ? 'HABILITADA' : 'EN REVISIÓN');
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
                Ver Ticket QR ➔
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
  // PANEL STAFF Y EXPORTACIÓN PDF
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
      alert('PIN incorrecto.');
    }
  }

  function closeAdminDashboard() {
    const modalDash = document.getElementById('modal-admin-dashboard');
    if (modalDash) modalDash.classList.add('hidden');
  }

  function switchAdminTab(tab) {
    const btnApp = document.getElementById('tab-btn-approvals');
    const btnDoor = document.getElementById('tab-btn-door');
    const viewApp = document.getElementById('adm-view-approvals') || document.getElementById('section-approvals');
    const viewDoor = document.getElementById('adm-view-door') || document.getElementById('section-door');

    if (tab === 'approvals') {
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
          <button onclick="window.approveOrder('${order.firestoreId}')" class="btn-approve">Aprobar</button>
          <button onclick="window.rejectOrder('${order.firestoreId}')" class="btn-reject">Rechazar</button>
        </div>
      `;
      list.appendChild(item);
    });
  }

  async function approveOrder(id) {
    try {
      const { error } = await client.from('orders').update({ status: 'approved' }).eq('id', id);
      if (error) throw error;
      await fetchOrders();
    } catch (err) {
      alert("Error al aprobar: " + err.message);
    }
  }

  async function rejectOrder(id) {
    if (!confirm("¿Rechazar orden?")) return;
    try {
      const { error } = await client.from('orders').update({ status: 'rejected' }).eq('id', id);
      if (error) throw error;
      await fetchOrders();
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
          `<button onclick="window.manualCheckIn('${order.firestoreId}')" class="btn-approve" style="font-size:0.7rem">Marcar Ingreso</button>`
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
    } catch (e) { }

    const cleanQ = cleanDni(query);
    const order = cloudOrders.find(o =>
      o.status === 'approved' &&
      (o.ticketId.toLowerCase() === query.toLowerCase() || (cleanQ && o.dni === cleanQ) || (o.orderId && o.orderId.toLowerCase() === query.toLowerCase()))
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
      const { error } = await client.from('orders').update({ used: true }).eq('id', order.firestoreId);
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
      await fetchOrders();
    } catch (err) {
      alert("Error al validar: " + err.message);
    }
  }

  async function manualCheckIn(id) {
    try {
      const { error } = await client.from('orders').update({ used: true }).eq('id', id);
      if (error) throw error;
      await fetchOrders();
    } catch (err) {
      alert("Error al marcar ingreso: " + err.message);
    }
  }

  // EXPORTADOR OFICIAL A PDF (PLANILLA A4)
  function exportDoorListPDF() {
    if (typeof window.jspdf === 'undefined') {
      alert("Cargando motor de PDF, aguarde un momento...");
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
    doc.setFontSize(14);
    doc.text("HAVANNA CLUB // HALLOWEEN OBSESSION 2026", 14, 15);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`PLANILLA OFICIAL DE CONTROL EN PUERTA - TOTAL: ${approved.length} ASISTENTES`, 14, 21);
    doc.text(`Fecha de emisión: ${new Date().toLocaleString('es-AR')}`, 14, 26);
    doc.line(14, 28, 196, 28);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    let y = 34;
    doc.text("N°", 14, y);
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
        doc.text("N°", 14, y);
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
      doc.rect(185, y - 3.5, 4, 4); // Casilla para marcar con lapicera

      y += 6;
    });

    doc.save(`Lista_Puerta_Havanna_Halloween_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  // EXPOSICIÓN GLOBAL
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
  window.approveOrder = approveOrder;
  window.rejectOrder = rejectOrder;
  window.validateDoorCheckIn = validateDoorCheckIn;
  window.manualCheckIn = manualCheckIn;
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
