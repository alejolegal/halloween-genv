// =====================================================================
//  Capa de datos. Toda la lógica de negocio sensible (precios, cupos,
//  aprobaciones) vive en la base de datos (funciones RPC de Supabase).
//  Agregando ?demo=1 a la URL se usa un backend local de prueba.
// =====================================================================
import { CONFIG } from './config.js';

const ERRORS = {
  VENTAS_CERRADAS: 'La venta online está cerrada en este momento.',
  METODO_INVALIDO: 'Elegí un método de pago válido.',
  NOMBRE_INVALIDO: 'Revisá los nombres: deben tener entre 3 y 80 caracteres.',
  DNI_INVALIDO: 'Revisá los DNI: deben tener entre 7 y 9 números, sin puntos.',
  TELEFONO_INVALIDO: 'Ingresá un WhatsApp válido (solo números, con característica).',
  EMAIL_INVALIDO: 'Ingresá un email válido.',
  CANTIDAD_INVALIDA: 'Cantidad de entradas inválida.',
  ASISTENTES_INVALIDOS: 'Completá los datos de cada asistente.',
  DNI_REPETIDO: 'Hay un DNI repetido entre los asistentes ({x}). Cada entrada es personal.',
  DNI_YA_REGISTRADO: 'El DNI {x} ya tiene una entrada (o una reserva activa). Buscala en "Mis entradas".',
  DEMASIADAS_PENDIENTES: 'Ya tenés reservas pendientes con este WhatsApp. Pagalas o esperá que venzan.',
  SIN_CUPO: 'No quedan cupos suficientes para esa cantidad. Probá con menos entradas.',
  NO_AUTORIZADO: 'No tenés permisos para esta acción.',
  ORDEN_NO_ENCONTRADA: 'No encontramos esa orden.',
};

export function humanError(err) {
  const raw = String(err?.message || err || '');
  const match = raw.match(/([A-Z_]{5,})(?::(\S+))?/);
  if (match && ERRORS[match[1]]) return ERRORS[match[1]].replace('{x}', match[2] || '');
  if (/Failed to fetch|NetworkError|network/i.test(raw)) return 'Sin conexión. Revisá tu internet e intentá de nuevo.';
  if (/function .* does not exist|Could not find the function/i.test(raw)) {
    return 'La venta todavía no está habilitada. Volvé a intentar en unos minutos.';
  }
  return 'Ocurrió un error inesperado. Intentá de nuevo.';
}

function isDemo() {
  try {
    const p = new URLSearchParams(location.search);
    if (p.has('demo')) sessionStorage.setItem('xmas_demo', p.get('demo') === '0' ? '0' : '1');
    return sessionStorage.getItem('xmas_demo') === '1';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
//  SUPABASE
// ---------------------------------------------------------------------
function supabaseApi() {
  if (!window.supabase?.createClient) throw new Error('No se pudo cargar Supabase');
  const sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, storageKey: 'xmas-staff-auth' },
  });

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw error;
    return data;
  }

  async function fn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let detail = '';
      try { detail = (await error.context?.json())?.error || ''; } catch { /* noop */ }
      throw new Error(detail || error.message);
    }
    return data;
  }

  return {
    mode: 'supabase',
    salesStatus: () => rpc('xmas_sales_status'),
    createOrder: (buyer, attendees, method) =>
      rpc('xmas_create_order', { p_buyer: buyer, p_attendees: attendees, p_method: method }),
    orderStatus: (code, dni) => rpc('xmas_order_status', { p_code: code, p_dni: dni }),
    lookup: (dni) => rpc('xmas_lookup', { p_dni: dni }),
    cancelOrder: (code, dni) => rpc('xmas_cancel_order', { p_code: code, p_dni: dni }),
    mpCreate: async (code, dni) => (await fn('mp-checkout', { action: 'create', code, dni })).init_point,
    mpVerify: async (code, dni, paymentId) =>
      (await fn('mp-checkout', { action: 'verify', code, dni, payment_id: paymentId })).status,

    // ---- Staff
    async getSession() {
      const { data } = await sb.auth.getSession();
      const user = data.session?.user;
      if (!user) return null;
      const { data: staff } = await sb.from('xmas_staff').select('role, name').eq('user_id', user.id).maybeSingle();
      return { user, role: staff?.role || null, name: staff?.name || user.email };
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return this.getSession();
    },
    signOut: () => sb.auth.signOut(),
    async listOrders() {
      const all = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await sb
          .from('xmas_orders')
          .select('*, xmas_tickets(id, code, tier_id, price, seq, holder_name, holder_dni, used_at)')
          .order('created_at', { ascending: false })
          .range(from, from + page - 1);
        if (error) throw error;
        all.push(...data);
        if (data.length < page) break;
      }
      return all.map((o) => ({ ...o, tickets: (o.xmas_tickets || []).sort((a, b) => a.seq - b.seq) }));
    },
    listTiers: async () => {
      const { data, error } = await sb.from('xmas_tiers').select('*').order('sort');
      if (error) throw error;
      return data;
    },
    approveOrder: (id) => rpc('xmas_approve_order', { p_order_id: id }),
    rejectOrder: (id) => rpc('xmas_reject_order', { p_order_id: id }),
    checkIn: ({ code, ticketId }) => rpc('xmas_check_in', { p_code: code || null, p_ticket_id: ticketId || null }),
    undoCheckIn: (ticketId) => rpc('xmas_undo_check_in', { p_ticket_id: ticketId }),
    async getSettings() {
      const { data, error } = await sb.from('xmas_settings').select('*').maybeSingle();
      if (error) throw error;
      return data;
    },
    async updateSettings(patch) {
      const { error } = await sb.from('xmas_settings').update(patch).eq('id', true);
      if (error) throw error;
    },
    subscribe(onChange) {
      const ch = sb
        .channel('xmas-staff')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'xmas_orders' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'xmas_tickets' }, onChange)
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

// ---------------------------------------------------------------------
//  DEMO (localStorage) — mismo contrato que Supabase, solo para pruebas
// ---------------------------------------------------------------------
function demoApi() {
  const KEY = 'xmas_demo_db_v1';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHA[b % 32]).join('');
  const now = () => Date.now();

  function load() {
    try {
      const db = JSON.parse(localStorage.getItem(KEY));
      if (db) return db;
    } catch { /* noop */ }
    return {
      settings: { sales_open: true, max_per_order: 4, transfer_hold_hours: 24, mp_hold_minutes: 30 },
      tiers: [
        { id: 0, name: 'Tanda Navideña de Regalo', subtitle: 'Solo 25 cupos · precio especial', price: 6000, capacity: 25, sort: 0, base: 25 },
        { id: 1, name: 'Tanda 1', subtitle: 'Preventa', price: 10000, capacity: 100, sort: 1, base: 78 },
        { id: 2, name: 'Tanda 2', subtitle: 'Preventa', price: 12000, capacity: 100, sort: 2, base: 0 },
        { id: 3, name: 'Tanda 3', subtitle: 'Última tanda', price: 15000, capacity: 100, sort: 3, base: 0 },
      ],
      orders: [],
    };
  }
  const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
  const holds = (o) => o.status === 'approved' || (o.status === 'pending' && new Date(o.expires_at).getTime() > now());
  const eff = (o) => (o.status === 'pending' && new Date(o.expires_at).getTime() <= now() ? 'expired' : o.status);
  const used = (db, tierId) =>
    db.orders.filter(holds).flatMap((o) => o.tickets).filter((t) => t.tier_id === tierId).length;
  const fail = (code) => { throw new Error(code); };
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 250));
  const publicOrder = (db, o, dni) => ({
    code: o.code, status: eff(o), payment_method: o.payment_method, total: o.total, quantity: o.quantity,
    buyer_name: o.buyer_name, dni: o.dni, expires_at: o.expires_at, created_at: o.created_at,
    mp_init_point: o.status === 'pending' ? o.mp_init_point || null : null,
    tickets: o.tickets
      .filter((t) => !dni || o.dni === dni || t.holder_dni === dni)
      .map((t) => ({
        code: o.status === 'approved' ? t.code : null, seq: t.seq, price: t.price,
        tier: db.tiers.find((x) => x.id === t.tier_id).name,
        holder_name: t.holder_name, holder_dni: t.holder_dni, used: !!t.used_at,
      })),
  });
  let listeners = [];
  const emit = () => listeners.forEach((l) => l());

  return {
    mode: 'demo',
    async salesStatus() {
      const db = load();
      const tiers = db.tiers.map((t) => {
        const sold = t.base + db.orders.filter((o) => o.status === 'approved').flatMap((o) => o.tickets).filter((x) => x.tier_id === t.id).length;
        const reserved = db.orders.filter((o) => o.status === 'pending' && holds(o)).flatMap((o) => o.tickets).filter((x) => x.tier_id === t.id).length;
        return { ...t, sold, reserved, remaining: Math.max(t.capacity - sold - reserved, 0) };
      });
      return delay({
        sales_open: db.settings.sales_open, max_per_order: db.settings.max_per_order, tiers,
        current_tier_id: tiers.find((t) => t.remaining > 0)?.id ?? null,
        total_capacity: tiers.reduce((a, t) => a + t.capacity, 0),
        total_sold: tiers.reduce((a, t) => a + t.sold + t.reserved, 0),
        sold_last_24h: 37, last_sale_at: new Date(now() - 4 * 60000).toISOString(),
      });
    },
    async createOrder(buyer, attendees, method) {
      const db = load();
      if (!db.settings.sales_open) fail('VENTAS_CERRADAS');
      const dni = String(buyer.dni).replace(/\D/g, '');
      if (!/^\d{7,9}$/.test(dni)) fail('DNI_INVALIDO');
      const dnis = attendees.map((a) => String(a.dni).replace(/\D/g, ''));
      dnis.forEach((d, i) => { if (dnis.indexOf(d) !== i) fail('DNI_REPETIDO:' + d); });
      const taken = db.orders.filter(holds).flatMap((o) => o.tickets).find((t) => dnis.includes(t.holder_dni));
      if (taken) fail('DNI_YA_REGISTRADO:' + taken.holder_dni);
      const tickets = [];
      for (const tier of db.tiers) {
        let left = tier.capacity - tier.base - used(db, tier.id);
        while (left-- > 0 && tickets.length < attendees.length) {
          const a = attendees[tickets.length];
          tickets.push({ id: crypto.randomUUID(), code: 'XM' + rand(10), tier_id: tier.id, price: tier.price,
            seq: tickets.length + 1, holder_name: a.name.trim(), holder_dni: String(a.dni).replace(/\D/g, ''), used_at: null });
        }
      }
      if (tickets.length < attendees.length) fail('SIN_CUPO');
      const hold = method === 'mercadopago' ? db.settings.mp_hold_minutes * 60000 : db.settings.transfer_hold_hours * 3600000;
      const order = {
        id: crypto.randomUUID(), code: 'NAV-' + rand(6), buyer_name: buyer.name.trim(), dni,
        phone: String(buyer.phone).replace(/\D/g, ''), email: buyer.email.trim().toLowerCase(),
        quantity: tickets.length, total: tickets.reduce((a, t) => a + t.price, 0), payment_method: method,
        status: 'pending', expires_at: new Date(now() + hold).toISOString(), created_at: new Date().toISOString(), tickets,
      };
      db.orders.unshift(order);
      save(db); emit();
      return delay({ code: order.code, total: order.total, quantity: order.quantity, payment_method: method, expires_at: order.expires_at });
    },
    async orderStatus(code, dni) {
      const db = load();
      const o = db.orders.find((x) => x.code === code && x.dni === dni);
      return delay(o ? publicOrder(db, o) : null);
    },
    async lookup(dni) {
      const db = load();
      return delay(db.orders
        .filter((o) => ['pending', 'approved'].includes(o.status) && (o.dni === dni || o.tickets.some((t) => t.holder_dni === dni)))
        .map((o) => publicOrder(db, o, dni)));
    },
    async cancelOrder(code, dni) {
      const db = load();
      const o = db.orders.find((x) => x.code === code && x.dni === dni && x.status === 'pending');
      if (o) { o.status = 'cancelled'; save(db); emit(); }
      return delay(!!o);
    },
    async mpCreate(code, dni) {
      return delay(`${location.pathname}?orden=${code}&dni=${dni}&payment_id=demo&status=approved`);
    },
    async mpVerify(code, dni, paymentId) {
      const db = load();
      const o = db.orders.find((x) => x.code === code && x.dni === dni);
      if (o && paymentId && o.status === 'pending') {
        Object.assign(o, { status: 'approved', approved_via: 'mercadopago', approved_at: new Date().toISOString(), mp_payment_id: 'demo' });
        save(db); emit();
      }
      return delay(o?.status);
    },

    // ---- Staff (demo: cualquier email; contiene "puerta" => rol puerta)
    async getSession() {
      const s = sessionStorage.getItem('xmas_demo_staff');
      return s ? JSON.parse(s) : null;
    },
    async signIn(email) {
      const s = { user: { email }, role: /puerta|door/i.test(email) ? 'door' : 'admin', name: email };
      sessionStorage.setItem('xmas_demo_staff', JSON.stringify(s));
      return s;
    },
    async signOut() { sessionStorage.removeItem('xmas_demo_staff'); },
    async listOrders() { return delay(load().orders.map((o) => ({ ...o }))); },
    async listTiers() { return load().tiers; },
    async approveOrder(id) {
      const db = load();
      const o = db.orders.find((x) => x.id === id);
      Object.assign(o, { status: 'approved', approved_via: 'staff', approved_at: new Date().toISOString() });
      save(db); emit();
      return { ok: true };
    },
    async rejectOrder(id) {
      const db = load();
      const o = db.orders.find((x) => x.id === id && x.status === 'pending');
      if (o) o.status = 'rejected';
      save(db); emit();
      return !!o;
    },
    async checkIn({ code, ticketId }) {
      const db = load();
      const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (const o of db.orders) {
        const t = o.tickets.find((x) => (ticketId ? x.id === ticketId : x.code === c));
        if (!t) continue;
        const tier = db.tiers.find((x) => x.id === t.tier_id).name;
        if (o.status !== 'approved') return { result: 'not_approved', status: eff(o), holder_name: t.holder_name, holder_dni: t.holder_dni };
        if (t.used_at) return { result: 'used', used_at: t.used_at, ticket_id: t.id, code: t.code, holder_name: t.holder_name, holder_dni: t.holder_dni, tier };
        t.used_at = new Date().toISOString();
        save(db); emit();
        return { result: 'ok', ticket_id: t.id, code: t.code, holder_name: t.holder_name, holder_dni: t.holder_dni, tier, order_code: o.code, seq: t.seq, quantity: o.quantity };
      }
      return { result: 'not_found' };
    },
    async undoCheckIn(ticketId) {
      const db = load();
      db.orders.flatMap((o) => o.tickets).filter((t) => t.id === ticketId).forEach((t) => { t.used_at = null; });
      save(db); emit();
      return true;
    },
    async getSettings() { return load().settings; },
    async updateSettings(patch) { const db = load(); Object.assign(db.settings, patch); save(db); emit(); },
    subscribe(cb) {
      listeners.push(cb);
      const onStorage = (e) => e.key === KEY && cb();
      window.addEventListener('storage', onStorage);
      return () => { listeners = listeners.filter((l) => l !== cb); window.removeEventListener('storage', onStorage); };
    },
  };
}

function offlineApi() {
  const down = async () => { throw new Error('Failed to fetch'); };
  return new Proxy({ mode: 'offline', getSession: async () => null, subscribe: () => () => {} }, {
    get: (target, prop) => (prop in target ? target[prop] : down),
  });
}

function createApi() {
  if (isDemo()) return demoApi();
  try {
    return supabaseApi();
  } catch (e) {
    console.error(e);
    return offlineApi();
  }
}

export const api = createApi();
