-- =====================================================================
--  NAVIDAD GEN V · Actualización 003 · Venta en puerta
--  El staff carga en el panel cada entrada vendida en puerta (nombre + DNI
--  + medio de pago + monto). Queda aprobada al instante y, opcionalmente,
--  con el ingreso marcado. No descuenta cupo de las anticipadas.
--  Idempotente: se puede correr más de una vez.
-- =====================================================================

-- Tanda interna "Venta en puerta" (inactiva: no aparece en la web pública)
insert into public.xmas_tiers (id, name, subtitle, price, capacity, sort, is_active)
values (99, 'Venta en puerta', 'Cargada por el staff', 1, 0, 99, false)
on conflict (id) do nothing;

alter table public.xmas_settings add column if not exists door_price integer not null default 15000;

-- Nuevo medio de venta 'door' + detalle del pago en puerta
alter table public.xmas_orders drop constraint if exists xmas_orders_payment_method_check;
alter table public.xmas_orders add constraint xmas_orders_payment_method_check
  check (payment_method in ('mercadopago', 'transfer', 'door'));
alter table public.xmas_orders add column if not exists door_payment text;
alter table public.xmas_orders drop constraint if exists xmas_orders_door_payment_check;
alter table public.xmas_orders add constraint xmas_orders_door_payment_check
  check (door_payment is null or door_payment in ('efectivo', 'mercadopago', 'transferencia', 'cortesia'));

create or replace function public.xmas_door_sale(
  p_name text, p_dni text, p_payment text, p_amount integer, p_check_in boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_dni     text := regexp_replace(coalesce(p_dni, ''), '\D', '', 'g');
  v_amount  integer := case when p_payment = 'cortesia' then 0 else coalesce(p_amount, 0) end;
  v_taken   record;
  v_code    text;
  v_tcode   text;
  v_order   uuid;
  v_ticket  uuid;
begin
  if not public.xmas_is_staff() then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 80 then
    raise exception 'NOMBRE_INVALIDO' using errcode = 'P0001';
  end if;
  if v_dni !~ '^\d{7,9}$' then
    raise exception 'DNI_INVALIDO' using errcode = 'P0001';
  end if;
  if p_payment not in ('efectivo', 'mercadopago', 'transferencia', 'cortesia') then
    raise exception 'METODO_INVALIDO' using errcode = 'P0001';
  end if;
  if v_amount < 0 or v_amount > 1000000 then
    raise exception 'MONTO_INVALIDO' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('xmas_sales'));

  -- Si ese DNI ya tiene entrada aprobada, no se duplica: se devuelve la existente
  select t.id, t.code, t.holder_name, t.used_at, tr.name as tier
    into v_taken
    from public.xmas_tickets t
    join public.xmas_orders o on o.id = t.order_id
    join public.xmas_tiers tr on tr.id = t.tier_id
   where t.holder_dni = v_dni and o.status = 'approved'
   limit 1;
  if found then
    return jsonb_build_object('result', 'exists', 'ticket_id', v_taken.id, 'code', v_taken.code,
      'holder_name', v_taken.holder_name, 'holder_dni', v_dni, 'tier', v_taken.tier, 'used_at', v_taken.used_at);
  end if;

  loop
    v_code := 'NAV-' || public.xmas_random_code(6);
    exit when not exists (select 1 from public.xmas_orders where code = v_code);
  end loop;
  loop
    v_tcode := 'XM' || public.xmas_random_code(10);
    exit when not exists (select 1 from public.xmas_tickets where code = v_tcode);
  end loop;

  insert into public.xmas_orders (code, buyer_name, dni, phone, email, quantity, subtotal, total,
                                  payment_method, door_payment, status, expires_at,
                                  approved_at, approved_by, approved_via)
  values (v_code, v_name, v_dni, '', '', 1, v_amount, v_amount,
          'door', p_payment, 'approved', now(), now(), auth.uid(), 'staff')
  returning id into v_order;

  insert into public.xmas_tickets (code, order_id, tier_id, price, seq, holder_name, holder_dni, used_at, checked_in_by)
  values (v_tcode, v_order, 99, v_amount, 1, v_name, v_dni,
          case when p_check_in then now() end, case when p_check_in then auth.uid() end)
  returning id into v_ticket;

  return jsonb_build_object('result', 'ok', 'ticket_id', v_ticket, 'code', v_tcode, 'order_code', v_code,
    'holder_name', v_name, 'holder_dni', v_dni, 'tier', 'Venta en puerta', 'checked_in', p_check_in);
end;
$$;

revoke all on function public.xmas_door_sale(text, text, text, integer, boolean) from public, anon;
grant execute on function public.xmas_door_sale(text, text, text, integer, boolean) to authenticated;
