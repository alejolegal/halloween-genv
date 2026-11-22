-- =====================================================================
--  NAVIDAD GEN V · Actualización 004
--  La web pública muestra el precio de la entrada en puerta (door_price),
--  que se vende cuando se agotan las 325 anticipadas.
--  Idempotente.
-- =====================================================================
update public.xmas_settings set door_price = 20000 where id and door_price is distinct from 20000;

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
    select t.tier_id, count(*) filter (where o.status = 'approved') as sold
      from public.xmas_tickets t
      join public.xmas_orders o on o.id = t.order_id
     group by t.tier_id
  ),
  tiers as (
    select tr.id, tr.name, tr.subtitle, tr.price, tr.capacity, tr.sort,
           coalesce(c.sold, 0) as sold,
           0 as reserved,
           greatest(tr.capacity - coalesce(c.sold, 0), 0) as remaining
      from public.xmas_tiers tr
      left join counts c on c.tier_id = tr.id
     where tr.is_active
  )
  select jsonb_build_object(
    'sales_open',      coalesce(s.sales_open, false),
    'max_per_order',   coalesce(s.max_per_order, 4),
    'mp_fee_percent',  coalesce(s.mp_fee_percent, 0),
    'door_price',      coalesce(s.door_price, 0),
    'tiers',           coalesce((select jsonb_agg(to_jsonb(tiers) order by sort) from tiers), '[]'::jsonb),
    'current_tier_id', (select id from tiers where remaining > 0 order by sort limit 1),
    'total_capacity',  coalesce((select sum(capacity) from tiers), 0),
    'total_sold',      coalesce((select sum(sold) from tiers), 0),
    'sold_last_24h',   (select count(*) from public.xmas_tickets t
                          join public.xmas_orders o on o.id = t.order_id
                          join public.xmas_tiers tr on tr.id = t.tier_id and tr.is_active
                         where o.status = 'approved' and o.approved_at > now() - interval '24 hours'),
    'last_sale_at',    (select max(o.approved_at) from public.xmas_orders o
                         where o.status = 'approved' and o.payment_method <> 'door'),
    'server_time',     now()
  ) into result;

  return result;
end;
$$;

revoke all on function public.xmas_sales_status() from public;
grant execute on function public.xmas_sales_status() to anon, authenticated;
