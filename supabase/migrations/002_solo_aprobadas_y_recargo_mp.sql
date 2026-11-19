-- =====================================================================
--  NAVIDAD GEN V · Actualización 002
--  Correr DESPUÉS de 001 (Supabase > SQL Editor > New query > Run).
--  Es idempotente: se puede correr más de una vez.
--
--  Cambios:
--   1. Las reservas YA NO descuentan entradas. Solo cuentan como vendidas
--      las órdenes aprobadas (por el staff o por pago acreditado en MP).
--   2. Recargo configurable para Mercado Pago (xmas_settings.mp_fee_percent)
--      calculado para que recibas el precio completo de la entrada.
--   3. Una nueva compra del mismo DNI comprador reemplaza su compra
--      pendiente anterior (evita quedar "trabado" tras un intento fallido).
--   4. Al aprobar a mano se avisa si la tanda ya está completa o si algún
--      DNI ya tiene entrada aprobada.
-- =====================================================================

alter table public.xmas_settings
  add column if not exists mp_fee_percent numeric(5,2) not null default 0;

do $$
begin
  alter table public.xmas_settings
    add constraint xmas_settings_mp_fee_chk check (mp_fee_percent >= 0 and mp_fee_percent < 30);
exception when duplicate_object then null;
end $$;

alter table public.xmas_orders add column if not exists subtotal  integer;
alter table public.xmas_orders add column if not exists surcharge integer not null default 0;
update public.xmas_orders set subtotal = total where subtotal is null;

-- ---------------------------------------------------------------------
-- Estado de venta: solo las APROBADAS descuentan cupo
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
           count(*) filter (where o.status = 'approved')                         as sold,
           count(*) filter (where o.status = 'pending' and o.expires_at > now()) as pending
      from public.xmas_tickets t
      join public.xmas_orders o on o.id = t.order_id
     group by t.tier_id
  ),
  tiers as (
    select tr.id, tr.name, tr.subtitle, tr.price, tr.capacity, tr.sort,
           coalesce(c.sold, 0)    as sold,
           0                      as reserved,   -- compatibilidad: las reservas no descuentan
           coalesce(c.pending, 0) as pending,
           greatest(tr.capacity - coalesce(c.sold, 0), 0) as remaining
      from public.xmas_tiers tr
      left join counts c on c.tier_id = tr.id
     where tr.is_active
  )
  select jsonb_build_object(
    'sales_open',      coalesce(s.sales_open, false),
    'max_per_order',   coalesce(s.max_per_order, 4),
    'mp_fee_percent',  coalesce(s.mp_fee_percent, 0),
    'tiers',           coalesce((select jsonb_agg(to_jsonb(tiers) - 'pending' order by sort) from tiers), '[]'::jsonb),
    'current_tier_id', (select id from tiers where remaining > 0 order by sort limit 1),
    'total_capacity',  coalesce((select sum(capacity) from tiers), 0),
    'total_sold',      coalesce((select sum(sold) from tiers), 0),
    'sold_last_24h',   (select count(*) from public.xmas_tickets t join public.xmas_orders o on o.id = t.order_id
                         where o.status = 'approved' and o.approved_at > now() - interval '24 hours'),
    'last_sale_at',    (select max(approved_at) from public.xmas_orders where status = 'approved'),
    'server_time',     now()
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------
-- Crear orden (las pendientes no ocupan cupo)
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
  v_subtotal   integer := 0;
  v_surcharge  integer := 0;
  v_expires    timestamptz;
  v_att        jsonb;
  v_att_name   text;
  v_att_dni    text;
  v_dnis       text[] := '{}';
  v_taken      text;
  v_tier       record;
  v_left       integer;
  v_assigned   integer := 0;
  v_take       integer;
  v_seq        integer := 0;
  v_tcode      text;
begin
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
  if p_method = 'mercadopago' and v_qty > 1 then
    raise exception 'MP_UNA_ENTRADA' using errcode = 'P0001';
  end if;

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

  -- Un DNI no puede tener dos entradas APROBADAS
  select t.holder_dni into v_taken
    from public.xmas_tickets t
    join public.xmas_orders o on o.id = t.order_id
   where t.holder_dni = any(v_dnis) and o.status = 'approved'
   limit 1;
  if v_taken is not null then
    raise exception 'DNI_YA_REGISTRADO:%', v_taken using errcode = 'P0001';
  end if;

  -- La nueva compra reemplaza las pendientes anteriores del mismo comprador
  update public.xmas_orders set status = 'cancelled',
         admin_note = coalesce(admin_note || ' · ', '') || 'Reemplazada por una compra nueva'
   where dni = v_dni and status = 'pending';

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

  -- Tanda según entradas APROBADAS
  for v_tier in
    select tr.id, tr.name, tr.price, tr.capacity,
           (select count(*) from public.xmas_tickets t join public.xmas_orders o on o.id = t.order_id
             where t.tier_id = tr.id and o.status = 'approved') as used
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
      v_subtotal := v_subtotal + v_tier.price;
    end loop;
    v_assigned := v_assigned + v_take;
  end loop;

  if v_assigned < v_qty then
    raise exception 'SIN_CUPO' using errcode = 'P0001';
  end if;

  -- Recargo MP: se calcula para que recibas el precio completo después de la comisión
  if p_method = 'mercadopago' and coalesce(s.mp_fee_percent, 0) > 0 then
    v_surcharge := (ceil(v_subtotal / (1 - s.mp_fee_percent / 100.0) / 10.0) * 10)::integer - v_subtotal;
  end if;

  update public.xmas_orders
     set subtotal = v_subtotal, surcharge = v_surcharge, total = v_subtotal + v_surcharge
   where id = v_order_id;

  return jsonb_build_object(
    'code', v_code, 'subtotal', v_subtotal, 'surcharge', v_surcharge, 'total', v_subtotal + v_surcharge,
    'quantity', v_qty, 'payment_method', p_method, 'expires_at', v_expires
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Aprobación manual con control de cupo y DNI
--   p_force = true para aprobar igual (ej: ya cobraste y la tanda se llenó)
-- ---------------------------------------------------------------------
drop function if exists public.xmas_approve_order(uuid, text);

create or replace function public.xmas_approve_order(p_order_id uuid, p_note text default null, p_force boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  o       public.xmas_orders;
  v_full  text;
  v_dni   text;
begin
  if not public.xmas_is_admin() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('xmas_sales'));

  select * into o from public.xmas_orders where id = p_order_id for update;
  if not found then raise exception 'ORDEN_NO_ENCONTRADA' using errcode = 'P0001'; end if;
  if o.status = 'approved' then return jsonb_build_object('ok', true, 'already', true); end if;

  if not p_force then
    select t.holder_dni into v_dni
      from public.xmas_tickets t
      join public.xmas_tickets t2 on t2.holder_dni = t.holder_dni and t2.order_id <> t.order_id
      join public.xmas_orders o2 on o2.id = t2.order_id and o2.status = 'approved'
     where t.order_id = o.id
     limit 1;
    if v_dni is not null then
      raise exception 'DNI_YA_APROBADO:%', v_dni using errcode = 'P0001';
    end if;

    select tr.name into v_full
      from public.xmas_tiers tr
      join (select tier_id, count(*) n from public.xmas_tickets where order_id = o.id group by tier_id) mine
        on mine.tier_id = tr.id
     where (select count(*) from public.xmas_tickets t join public.xmas_orders x on x.id = t.order_id
             where t.tier_id = tr.id and x.status = 'approved') + mine.n > tr.capacity
     limit 1;
    if v_full is not null then
      raise exception 'CUPO_EXCEDIDO:%', v_full using errcode = 'P0001';
    end if;
  end if;

  update public.xmas_orders
     set status = 'approved', approved_at = now(), approved_by = auth.uid(),
         approved_via = 'staff', admin_note = coalesce(p_note, admin_note)
   where id = p_order_id;

  return jsonb_build_object('ok', true, 'forced', p_force);
end;
$$;

revoke all on function public.xmas_approve_order(uuid, text, boolean) from public, anon;
grant execute on function public.xmas_approve_order(uuid, text, boolean) to authenticated;

revoke all on function public.xmas_create_order(jsonb, jsonb, text) from public;
grant execute on function public.xmas_create_order(jsonb, jsonb, text) to anon, authenticated;
revoke all on function public.xmas_sales_status() from public;
grant execute on function public.xmas_sales_status() to anon, authenticated;

-- El staff necesita poder leer/guardar el recargo (RLS ya limita a admin)
grant select, update on public.xmas_settings to authenticated;
