-- =====================================================================
--  NAVIDAD GEN V · Esquema de base de datos (Supabase / PostgreSQL)
-- ---------------------------------------------------------------------
--  Ejecutar completo en: Supabase > SQL Editor > New query > Run.
--  Es idempotente: se puede volver a correr sin romper datos.
--
--  Modelo:
--    xmas_tiers     -> tandas (precio, cupo, orden de venta)
--    xmas_settings  -> parámetros generales de venta
--    xmas_orders    -> una orden por compra (comprador, pago, estado)
--    xmas_tickets   -> un registro por entrada, nominal, con código QR único
--    xmas_staff     -> usuarios del staff (admin / puerta)
--
--  Seguridad:
--    * El público (rol anon) NO puede leer ni escribir tablas directamente.
--      Solo usa funciones RPC controladas (crear orden, ver disponibilidad,
--      consultar sus entradas por DNI).
--    * El staff inicia sesión con Supabase Auth y su permiso sale de xmas_staff.
--    * La aprobación automática de Mercado Pago solo la puede hacer el
--      service_role (Edge Function), nunca el navegador.
-- =====================================================================

-- ---------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------
create table if not exists public.xmas_tiers (
  id          smallint primary key,
  name        text     not null,
  subtitle    text,
  price       integer  not null check (price > 0),
  capacity    integer  not null check (capacity >= 0),
  sort        smallint not null,
  is_active   boolean  not null default true
);

create table if not exists public.xmas_settings (
  id                   boolean primary key default true check (id),
  sales_open           boolean not null default true,
  max_per_order        integer not null default 4 check (max_per_order between 1 and 10),
  transfer_hold_hours  integer not null default 24 check (transfer_hold_hours > 0),
  mp_hold_minutes      integer not null default 30 check (mp_hold_minutes >= 10)
);

create table if not exists public.xmas_orders (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  buyer_name       text not null,
  dni              text not null,
  phone            text not null,
  email            text not null,
  quantity         integer not null check (quantity > 0),
  total            integer not null check (total >= 0),
  payment_method   text not null check (payment_method in ('mercadopago', 'transfer')),
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  expires_at       timestamptz not null,
  mp_preference_id text,
  mp_init_point    text,
  mp_payment_id    text,
  mp_status        text,
  approved_at      timestamptz,
  approved_by      uuid,
  approved_via     text check (approved_via in ('mercadopago', 'staff')),
  admin_note       text,
  created_at       timestamptz not null default now()
);

create index if not exists xmas_orders_dni_idx     on public.xmas_orders (dni);
create index if not exists xmas_orders_status_idx  on public.xmas_orders (status, expires_at);

create table if not exists public.xmas_tickets (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  order_id      uuid not null references public.xmas_orders (id) on delete cascade,
  tier_id       smallint not null references public.xmas_tiers (id),
  price         integer not null,
  seq           integer not null,
  holder_name   text not null,
  holder_dni    text not null,
  used_at       timestamptz,
  checked_in_by uuid,
  created_at    timestamptz not null default now()
);

create index if not exists xmas_tickets_order_idx on public.xmas_tickets (order_id);
create index if not exists xmas_tickets_dni_idx   on public.xmas_tickets (holder_dni);
create index if not exists xmas_tickets_tier_idx  on public.xmas_tickets (tier_id);

create table if not exists public.xmas_staff (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null default 'door' check (role in ('admin', 'door')),
  name       text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- DATOS INICIALES (tandas). Modificá cupos/precios acá o en Table Editor.
-- ---------------------------------------------------------------------
insert into public.xmas_tiers (id, name, subtitle, price, capacity, sort) values
  (0, 'Tanda Navideña de Regalo', 'Solo 25 cupos · precio especial', 6000, 25, 0),
  (1, 'Tanda 1', 'Preventa', 10000, 100, 1),
  (2, 'Tanda 2', 'Preventa', 12000, 100, 2),
  (3, 'Tanda 3', 'Última tanda', 15000, 100, 3)
on conflict (id) do nothing;

insert into public.xmas_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- HELPERS
-- ---------------------------------------------------------------------
-- Código aleatorio criptográficamente seguro (sin caracteres ambiguos).
create or replace function public.xmas_random_code(p_len integer)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- 32 símbolos
  bytes bytea := '';
  out_code text := '';
  i integer;
begin
  while length(bytes) < p_len loop
    bytes := bytes || uuid_send(gen_random_uuid());
  end loop;
  for i in 0 .. p_len - 1 loop
    out_code := out_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return out_code;
end;
$$;

create or replace function public.xmas_is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.xmas_staff where user_id = auth.uid());
$$;

create or replace function public.xmas_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.xmas_staff where user_id = auth.uid() and role = 'admin');
$$;

-- Una orden "ocupa cupo" si está aprobada o pendiente sin vencer.
create or replace function public.xmas_order_holds_seat(p_status text, p_expires timestamptz)
returns boolean
language sql
stable
as $$
  select p_status = 'approved' or (p_status = 'pending' and p_expires > now());
$$;

-- Estado visible: una pendiente vencida se muestra como "expired".
create or replace function public.xmas_effective_status(p_status text, p_expires timestamptz)
returns text
language sql
stable
as $$
  select case when p_status = 'pending' and p_expires <= now() then 'expired' else p_status end;
$$;

-- ---------------------------------------------------------------------
-- RPC PÚBLICA: estado de venta (tandas, vendidas, restantes)
-- ---------------------------------------------------------------------
create or replace function public.xmas_sales_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  s public.xmas_settings;
begin
  select * into s from public.xmas_settings where id;

  with counts as (
    select t.tier_id,
           count(*) filter (where o.status = 'approved')                                as sold,
           count(*) filter (where o.status = 'pending' and o.expires_at > now())        as reserved
      from public.xmas_tickets t
      join public.xmas_orders o on o.id = t.order_id
     group by t.tier_id
  ),
  tiers as (
    select tr.id, tr.name, tr.subtitle, tr.price, tr.capacity, tr.sort,
           coalesce(c.sold, 0)     as sold,
           coalesce(c.reserved, 0) as reserved,
           greatest(tr.capacity - coalesce(c.sold, 0) - coalesce(c.reserved, 0), 0) as remaining
      from public.xmas_tiers tr
      left join counts c on c.tier_id = tr.id
     where tr.is_active
  )
  select jsonb_build_object(
    'sales_open',     coalesce(s.sales_open, false),
    'max_per_order',  coalesce(s.max_per_order, 4),
    'tiers', coalesce((select jsonb_agg(to_jsonb(tiers) order by sort) from tiers), '[]'::jsonb),
    'current_tier_id', (select id from tiers where remaining > 0 order by sort limit 1),
    'total_capacity', coalesce((select sum(capacity) from tiers), 0),
    'total_sold',     coalesce((select sum(sold + reserved) from tiers), 0),
    'sold_last_24h',  (select count(*) from public.xmas_tickets t join public.xmas_orders o on o.id = t.order_id
                        where o.status = 'approved' and o.approved_at > now() - interval '24 hours'),
    'last_sale_at',   (select max(approved_at) from public.xmas_orders where status = 'approved'),
    'server_time',    now()
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC PÚBLICA: crear orden (reserva cupo y genera tickets nominales)
--   p_buyer     = {"name","dni","phone","email"}
--   p_attendees = [{"name","dni"}, ...]   (una entrada nominal por persona;
--                 el comprador puede o no estar entre los asistentes)
--   p_method    = 'mercadopago' | 'transfer'
--   Si una compra cruza el límite de una tanda, cada entrada toma el precio
--   de la tanda a la que corresponde (nunca se sobrevende una tanda).
-- ---------------------------------------------------------------------
create or replace function public.xmas_create_order(p_buyer jsonb, p_attendees jsonb, p_method text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  s            public.xmas_settings;
  v_name       text := btrim(coalesce(p_buyer->>'name', ''));
  v_dni        text := regexp_replace(coalesce(p_buyer->>'dni', ''), '\D', '', 'g');
  v_phone      text := regexp_replace(coalesce(p_buyer->>'phone', ''), '\D', '', 'g');
  v_email      text := lower(btrim(coalesce(p_buyer->>'email', '')));
  v_qty        integer;
  v_order_id   uuid;
  v_code       text;
  v_total      integer := 0;
  v_expires    timestamptz;
  v_att        jsonb;
  v_att_name   text;
  v_att_dni    text;
  v_dnis       text[] := '{}';
  v_taken      text;
  v_pending    integer;
  v_tier       record;
  v_left       integer;
  v_assigned   integer := 0;
  v_take       integer;
  v_tickets    jsonb := '[]'::jsonb;
  v_seq        integer := 0;
  v_tcode      text;
begin
  -- Serializa las ventas para que dos compras simultáneas no tomen el mismo cupo.
  perform pg_advisory_xact_lock(hashtext('xmas_sales'));

  select * into s from public.xmas_settings where id;
  if not coalesce(s.sales_open, false) then
    raise exception 'VENTAS_CERRADAS' using errcode = 'P0001';
  end if;

  if p_method not in ('mercadopago', 'transfer') then
    raise exception 'METODO_INVALIDO' using errcode = 'P0001';
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 80 then
    raise exception 'NOMBRE_INVALIDO' using errcode = 'P0001';
  end if;
  if v_dni !~ '^\d{7,9}$' then
    raise exception 'DNI_INVALIDO' using errcode = 'P0001';
  end if;
  if v_phone !~ '^\d{8,15}$' then
    raise exception 'TELEFONO_INVALIDO' using errcode = 'P0001';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 120 then
    raise exception 'EMAIL_INVALIDO' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_attendees) <> 'array' then
    raise exception 'ASISTENTES_INVALIDOS' using errcode = 'P0001';
  end if;

  v_qty := jsonb_array_length(p_attendees);
  if v_qty < 1 or v_qty > s.max_per_order then
    raise exception 'CANTIDAD_INVALIDA' using errcode = 'P0001';
  end if;

  -- Validar asistentes (cada entrada es nominal: nombre + DNI propio)
  for v_att in select value from jsonb_array_elements(p_attendees) loop
    v_att_name := btrim(coalesce(v_att->>'name', ''));
    v_att_dni  := regexp_replace(coalesce(v_att->>'dni', ''), '\D', '', 'g');
    if char_length(v_att_name) < 3 or char_length(v_att_name) > 80 then
      raise exception 'NOMBRE_INVALIDO' using errcode = 'P0001';
    end if;
    if v_att_dni !~ '^\d{7,9}$' then
      raise exception 'DNI_INVALIDO' using errcode = 'P0001';
    end if;
    if v_att_dni = any(v_dnis) then
      raise exception 'DNI_REPETIDO:%', v_att_dni using errcode = 'P0001';
    end if;
    v_dnis := v_dnis || v_att_dni;
  end loop;

  -- Un DNI no puede tener dos entradas activas (anti reventa / duplicados)
  select t.holder_dni into v_taken
    from public.xmas_tickets t
    join public.xmas_orders o on o.id = t.order_id
   where t.holder_dni = any(v_dnis)
     and public.xmas_order_holds_seat(o.status, o.expires_at)
   limit 1;
  if v_taken is not null then
    raise exception 'DNI_YA_REGISTRADO:%', v_taken using errcode = 'P0001';
  end if;

  -- Anti-acaparamiento: máximo 2 órdenes pendientes por teléfono
  select count(*) into v_pending
    from public.xmas_orders
   where phone = v_phone and status = 'pending' and expires_at > now();
  if v_pending >= 2 then
    raise exception 'DEMASIADAS_PENDIENTES' using errcode = 'P0001';
  end if;

  v_expires := case when p_method = 'mercadopago'
                    then now() + make_interval(mins => s.mp_hold_minutes)
                    else now() + make_interval(hours => s.transfer_hold_hours) end;

  loop
    v_code := 'NAV-' || public.xmas_random_code(6);
    exit when not exists (select 1 from public.xmas_orders where code = v_code);
  end loop;

  insert into public.xmas_orders (code, buyer_name, dni, phone, email, quantity, total, payment_method, expires_at)
  values (v_code, v_name, v_dni, v_phone, v_email, v_qty, 0, p_method, v_expires)
  returning id into v_order_id;

  -- Asignar entradas a tandas en orden
  for v_tier in
    select tr.id, tr.name, tr.price, tr.capacity,
           (select count(*) from public.xmas_tickets t join public.xmas_orders o on o.id = t.order_id
             where t.tier_id = tr.id and o.id <> v_order_id
               and public.xmas_order_holds_seat(o.status, o.expires_at)) as used
      from public.xmas_tiers tr
     where tr.is_active
     order by tr.sort
  loop
    exit when v_assigned >= v_qty;
    v_left := v_tier.capacity - v_tier.used;
    continue when v_left <= 0;
    v_take := least(v_left, v_qty - v_assigned);

    for i in 1 .. v_take loop
      v_seq := v_seq + 1;
      v_att := p_attendees -> (v_seq - 1);
      loop
        v_tcode := 'XM' || public.xmas_random_code(10);
        exit when not exists (select 1 from public.xmas_tickets where code = v_tcode);
      end loop;
      insert into public.xmas_tickets (code, order_id, tier_id, price, seq, holder_name, holder_dni)
      values (v_tcode, v_order_id, v_tier.id, v_tier.price, v_seq,
              btrim(v_att->>'name'), regexp_replace(v_att->>'dni', '\D', '', 'g'));
      v_total := v_total + v_tier.price;
      v_tickets := v_tickets || jsonb_build_object('tier', v_tier.name, 'price', v_tier.price,
                                                   'holder_name', btrim(v_att->>'name'));
    end loop;
    v_assigned := v_assigned + v_take;
  end loop;

  if v_assigned < v_qty then
    raise exception 'SIN_CUPO' using errcode = 'P0001';  -- rollback total de la orden
  end if;

  update public.xmas_orders set total = v_total where id = v_order_id;

  return jsonb_build_object(
    'code', v_code, 'total', v_total, 'quantity', v_qty,
    'payment_method', p_method, 'expires_at', v_expires, 'tickets', v_tickets
  );
end;
$$;

-- ---------------------------------------------------------------------
-- RPC PÚBLICA: consultar entradas por DNI (comprador o titular)
--   No expone teléfono ni email. El código QR solo se entrega si la orden
--   está aprobada.
-- ---------------------------------------------------------------------
create or replace function public.xmas_lookup(p_dni text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dni text := regexp_replace(coalesce(p_dni, ''), '\D', '', 'g');
begin
  if v_dni !~ '^\d{7,9}$' then
    raise exception 'DNI_INVALIDO' using errcode = 'P0001';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'code', o.code,
             'status', public.xmas_effective_status(o.status, o.expires_at),
             'payment_method', o.payment_method,
             'total', o.total,
             'buyer_name', o.buyer_name,
             'expires_at', o.expires_at,
             'mp_init_point', case when o.status = 'pending' and o.expires_at > now() then o.mp_init_point end,
             'created_at', o.created_at,
             'tickets', (
               select jsonb_agg(jsonb_build_object(
                        'code', case when o.status = 'approved' then t.code end,
                        'seq', t.seq,
                        'tier', tr.name,
                        'price', t.price,
                        'holder_name', t.holder_name,
                        'holder_dni', t.holder_dni,
                        'used', t.used_at is not null
                      ) order by t.seq)
                 from public.xmas_tickets t
                 join public.xmas_tiers tr on tr.id = t.tier_id
                where t.order_id = o.id
                  and (o.dni = v_dni or t.holder_dni = v_dni)
             )
           ) order by o.created_at desc)
      from public.xmas_orders o
     where o.status in ('pending', 'approved')
       and (o.dni = v_dni or exists (select 1 from public.xmas_tickets t
                                      where t.order_id = o.id and t.holder_dni = v_dni))
  ), '[]'::jsonb);
end;
$$;

-- RPC PÚBLICA: estado de UNA orden (requiere código + DNI del comprador)
create or replace function public.xmas_order_status(p_code text, p_dni text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'code', o.code,
           'status', public.xmas_effective_status(o.status, o.expires_at),
           'payment_method', o.payment_method,
           'total', o.total,
           'quantity', o.quantity,
           'buyer_name', o.buyer_name,
           'dni', o.dni,
           'expires_at', o.expires_at,
           'mp_init_point', case when o.status = 'pending' and o.expires_at > now() then o.mp_init_point end,
           'tickets', (
             select jsonb_agg(jsonb_build_object(
                      'code', case when o.status = 'approved' then t.code end,
                      'seq', t.seq, 'tier', tr.name, 'price', t.price,
                      'holder_name', t.holder_name, 'holder_dni', t.holder_dni,
                      'used', t.used_at is not null) order by t.seq)
               from public.xmas_tickets t join public.xmas_tiers tr on tr.id = t.tier_id
              where t.order_id = o.id))
    from public.xmas_orders o
   where o.code = upper(btrim(p_code))
     and o.dni = regexp_replace(coalesce(p_dni, ''), '\D', '', 'g');
$$;

-- RPC PÚBLICA: cancelar una orden pendiente propia (libera el cupo)
create or replace function public.xmas_cancel_order(p_code text, p_dni text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.xmas_orders
     set status = 'cancelled'
   where code = upper(btrim(p_code))
     and dni = regexp_replace(coalesce(p_dni, ''), '\D', '', 'g')
     and status = 'pending';
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC STAFF
-- ---------------------------------------------------------------------
create or replace function public.xmas_approve_order(p_order_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  o public.xmas_orders;
begin
  if not public.xmas_is_admin() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  select * into o from public.xmas_orders where id = p_order_id for update;
  if not found then raise exception 'ORDEN_NO_ENCONTRADA' using errcode = 'P0001'; end if;
  if o.status = 'approved' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status not in ('pending', 'rejected', 'cancelled') then
    raise exception 'ESTADO_INVALIDO' using errcode = 'P0001';
  end if;

  update public.xmas_orders
     set status = 'approved', approved_at = now(), approved_by = auth.uid(),
         approved_via = 'staff', admin_note = coalesce(p_note, admin_note)
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'was_expired', o.expires_at <= now() or o.status <> 'pending');
end;
$$;

create or replace function public.xmas_reject_order(p_order_id uuid, p_note text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.xmas_is_admin() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  update public.xmas_orders
     set status = 'rejected', admin_note = coalesce(p_note, admin_note)
   where id = p_order_id and status = 'pending';
  return found;
end;
$$;

-- Control de ingreso atómico: un ticket se usa una sola vez aunque haya
-- varios celulares escaneando en simultáneo.
create or replace function public.xmas_check_in(p_code text default null, p_ticket_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  t   record;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not public.xmas_is_staff() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;

  select tk.id, tk.code, tk.holder_name, tk.holder_dni, tk.used_at, tk.seq,
         tr.name as tier, o.status, o.expires_at, o.code as order_code, o.quantity
    into t
    from public.xmas_tickets tk
    join public.xmas_orders o on o.id = tk.order_id
    join public.xmas_tiers tr on tr.id = tk.tier_id
   where (p_ticket_id is not null and tk.id = p_ticket_id)
      or (p_ticket_id is null and tk.code = v_code)
   for update of tk;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if t.status <> 'approved' then
    return jsonb_build_object('result', 'not_approved',
      'status', public.xmas_effective_status(t.status, t.expires_at),
      'holder_name', t.holder_name, 'holder_dni', t.holder_dni, 'order_code', t.order_code);
  end if;

  if t.used_at is not null then
    return jsonb_build_object('result', 'used', 'used_at', t.used_at, 'ticket_id', t.id,
      'code', t.code, 'holder_name', t.holder_name, 'holder_dni', t.holder_dni, 'tier', t.tier);
  end if;

  update public.xmas_tickets set used_at = now(), checked_in_by = auth.uid() where id = t.id;

  return jsonb_build_object('result', 'ok', 'ticket_id', t.id, 'code', t.code,
    'holder_name', t.holder_name, 'holder_dni', t.holder_dni, 'tier', t.tier,
    'order_code', t.order_code, 'seq', t.seq, 'quantity', t.quantity);
end;
$$;

create or replace function public.xmas_undo_check_in(p_ticket_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.xmas_is_admin() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  update public.xmas_tickets set used_at = null, checked_in_by = null where id = p_ticket_id;
  return found;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC SISTEMA (solo service_role / Edge Function de Mercado Pago)
-- ---------------------------------------------------------------------
create or replace function public.xmas_mp_register_payment(
  p_order_id uuid, p_payment_id text, p_status text, p_amount numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  o public.xmas_orders;
begin
  select * into o from public.xmas_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  update public.xmas_orders set mp_payment_id = p_payment_id, mp_status = p_status where id = o.id;

  -- Pago devuelto o contracargo: se anulan las entradas
  if p_status in ('refunded', 'charged_back') and o.status = 'approved' and o.approved_via = 'mercadopago' then
    update public.xmas_orders
       set status = 'rejected', admin_note = 'Pago MP ' || p_status || ' (entradas anuladas)'
     where id = o.id;
    return jsonb_build_object('ok', true, 'approved', false, 'status', p_status, 'revoked', true);
  end if;

  if p_status <> 'approved' then
    return jsonb_build_object('ok', true, 'approved', false, 'status', p_status);
  end if;

  if p_amount < o.total then
    update public.xmas_orders set admin_note = 'Pago MP con monto menor al total: ' || p_amount where id = o.id;
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;

  if o.status = 'approved' then
    return jsonb_build_object('ok', true, 'approved', true, 'already', true);
  end if;

  update public.xmas_orders
     set status = 'approved', approved_at = now(), approved_via = 'mercadopago',
         admin_note = case when o.expires_at <= now() or o.status <> 'pending'
                           then 'Pago MP acreditado fuera de término (revisar cupo)' else admin_note end
   where id = o.id;

  return jsonb_build_object('ok', true, 'approved', true);
end;
$$;

-- ---------------------------------------------------------------------
-- VISTA DE CLIENTES (registro consolidado por DNI) — solo staff
-- ---------------------------------------------------------------------
create or replace view public.xmas_customers
with (security_invoker = true) as
select o.dni,
       (array_agg(o.buyer_name order by o.created_at desc))[1] as name,
       (array_agg(o.phone      order by o.created_at desc))[1] as phone,
       (array_agg(o.email      order by o.created_at desc))[1] as email,
       count(*)                                                 as orders,
       coalesce(sum(o.quantity) filter (where o.status = 'approved'), 0) as tickets_approved,
       coalesce(sum(o.total)    filter (where o.status = 'approved'), 0) as total_spent,
       min(o.created_at) as first_order_at,
       max(o.created_at) as last_order_at
  from public.xmas_orders o
 group by o.dni;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.xmas_tiers    enable row level security;
alter table public.xmas_settings enable row level security;
alter table public.xmas_orders   enable row level security;
alter table public.xmas_tickets  enable row level security;
alter table public.xmas_staff    enable row level security;

drop policy if exists xmas_tiers_read     on public.xmas_tiers;
drop policy if exists xmas_tiers_admin    on public.xmas_tiers;
drop policy if exists xmas_settings_read  on public.xmas_settings;
drop policy if exists xmas_settings_admin on public.xmas_settings;
drop policy if exists xmas_orders_staff   on public.xmas_orders;
drop policy if exists xmas_tickets_staff  on public.xmas_tickets;
drop policy if exists xmas_staff_self     on public.xmas_staff;

create policy xmas_tiers_read     on public.xmas_tiers    for select using (true);
create policy xmas_tiers_admin    on public.xmas_tiers    for update using (public.xmas_is_admin());
create policy xmas_settings_read  on public.xmas_settings for select using (true);
create policy xmas_settings_admin on public.xmas_settings for update using (public.xmas_is_admin());
create policy xmas_orders_staff   on public.xmas_orders   for select using (public.xmas_is_staff());
create policy xmas_tickets_staff  on public.xmas_tickets  for select using (public.xmas_is_staff());
create policy xmas_staff_self     on public.xmas_staff    for select using (user_id = auth.uid() or public.xmas_is_admin());

-- Permisos explícitos
revoke all on public.xmas_orders, public.xmas_tickets, public.xmas_staff from anon;
revoke insert, update, delete on public.xmas_orders, public.xmas_tickets, public.xmas_staff from authenticated;
revoke all on public.xmas_customers from anon;
grant select on public.xmas_customers to authenticated;

revoke all on function public.xmas_create_order(jsonb, jsonb, text) from public;
revoke all on function public.xmas_sales_status()                   from public;
revoke all on function public.xmas_lookup(text)                     from public;
revoke all on function public.xmas_order_status(text, text)         from public;
revoke all on function public.xmas_cancel_order(text, text)         from public;
revoke all on function public.xmas_approve_order(uuid, text)        from public;
revoke all on function public.xmas_reject_order(uuid, text)         from public;
revoke all on function public.xmas_check_in(text, uuid)             from public;
revoke all on function public.xmas_undo_check_in(uuid)              from public;
revoke all on function public.xmas_mp_register_payment(uuid, text, text, numeric) from public, anon, authenticated;
revoke all on function public.xmas_random_code(integer)             from public, anon, authenticated;

grant execute on function public.xmas_create_order(jsonb, jsonb, text) to anon, authenticated;
grant execute on function public.xmas_sales_status()                   to anon, authenticated;
grant execute on function public.xmas_lookup(text)                     to anon, authenticated;
grant execute on function public.xmas_order_status(text, text)         to anon, authenticated;
grant execute on function public.xmas_cancel_order(text, text)         to anon, authenticated;
grant execute on function public.xmas_approve_order(uuid, text)        to authenticated;
grant execute on function public.xmas_reject_order(uuid, text)         to authenticated;
grant execute on function public.xmas_check_in(text, uuid)             to authenticated;
grant execute on function public.xmas_undo_check_in(uuid)              to authenticated;
grant execute on function public.xmas_mp_register_payment(uuid, text, text, numeric) to service_role;

-- Realtime para el panel de staff (respeta RLS)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.xmas_orders;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.xmas_tickets;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- ALTA DE STAFF (ejecutar a mano luego de crear el usuario en
-- Authentication > Users > Add user):
--
--   insert into public.xmas_staff (user_id, role, name)
--   select id, 'admin', 'Alejo' from auth.users where email = 'TU_EMAIL';
--
--   -- personal de puerta (solo escanea / da ingreso):
--   insert into public.xmas_staff (user_id, role, name)
--   select id, 'door', 'Puerta 1' from auth.users where email = 'puerta1@...';
-- ---------------------------------------------------------------------
