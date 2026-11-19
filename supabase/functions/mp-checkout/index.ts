// Edge Function: mp-checkout
//   POST { action: 'create', code, dni }              -> { init_point }
//   POST { action: 'verify', code, dni, payment_id }  -> { status }
//
// 'create' arma la preferencia de pago de Mercado Pago para una orden
// pendiente. 'verify' se usa al volver de Mercado Pago: consulta el pago real
// a la API y habilita las entradas al instante (sin esperar el webhook).
import { adminClient, corsHeaders, env, json, mpFetch, processPayment } from '../_shared/mp.ts';

// Mercado Pago espera fechas con offset (ej: 2026-12-20T21:00:00.000-03:00)
function toArgentinaIso(date: Date): string {
  const ar = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return ar.toISOString().replace('Z', '-03:00');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const code = String(body.code ?? '').trim().toUpperCase();
    const dni = String(body.dni ?? '').replace(/\D/g, '');
    if (!code || !dni) return json({ error: 'datos_incompletos' }, 400);

    const db = adminClient();
    const { data: order, error } = await db
      .from('xmas_orders')
      .select('*, xmas_tickets(tier_id, price, xmas_tiers(name))')
      .eq('code', code)
      .eq('dni', dni)
      .maybeSingle();
    if (error) throw error;
    if (!order) return json({ error: 'orden_no_encontrada' }, 404);
    if (order.payment_method !== 'mercadopago') return json({ error: 'metodo_invalido' }, 400);

    // ------------------------------------------------------------- VERIFY
    if (body.action === 'verify') {
      const paymentId = String(body.payment_id ?? '').replace(/\D/g, '');
      if (paymentId) {
        try {
          await processPayment(db, paymentId);
        } catch (e) {
          console.error('verify error', e);
        }
      }
      const { data: fresh } = await db.from('xmas_orders').select('status').eq('id', order.id).single();
      return json({ status: fresh?.status ?? order.status });
    }

    // ------------------------------------------------------------- CREATE
    if (order.status !== 'pending') return json({ error: 'orden_no_pendiente', status: order.status }, 409);
    if (new Date(order.expires_at).getTime() <= Date.now()) return json({ error: 'orden_vencida' }, 409);
    if (order.mp_init_point) return json({ init_point: order.mp_init_point });

    const eventName = Deno.env.get('EVENT_NAME') || 'Navidad Gen V';
    const siteUrl = env('SITE_URL').replace(/\/$/, '');
    const returnUrl = `${siteUrl}/?orden=${encodeURIComponent(order.code)}&dni=${encodeURIComponent(order.dni)}`;

    // Agrupar entradas por tanda (una línea por tanda/precio)
    const groups = new Map<string, { title: string; unit_price: number; quantity: number }>();
    for (const t of order.xmas_tickets ?? []) {
      const key = `${t.tier_id}-${t.price}`;
      const g = groups.get(key) ?? {
        title: `Entrada ${eventName} · ${t.xmas_tiers?.name ?? 'General'}`,
        unit_price: t.price,
        quantity: 0,
      };
      g.quantity += 1;
      groups.set(key, g);
    }

    const [firstName, ...rest] = String(order.buyer_name).split(' ');
    const preference = await mpFetch('/checkout/preferences', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': order.id },
      body: JSON.stringify({
        items: [...groups.entries()].map(([id, g]) => ({
          id,
          title: g.title,
          quantity: g.quantity,
          unit_price: g.unit_price,
          currency_id: 'ARS',
        })),
        payer: {
          name: firstName,
          surname: rest.join(' '),
          email: order.email,
          identification: { type: 'DNI', number: order.dni },
        },
        external_reference: order.id,
        notification_url: `${env('SUPABASE_URL')}/functions/v1/mp-webhook`,
        back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
        auto_return: 'approved',
        binary_mode: true, // aprobado o rechazado al instante: sin pagos "en efectivo pendientes"
        statement_descriptor: (Deno.env.get('MP_STATEMENT') || 'NAVIDAD GENV').slice(0, 22),
        expires: true,
        expiration_date_to: toArgentinaIso(new Date(order.expires_at)),
        metadata: { order_code: order.code },
      }),
    });

    const initPoint: string = preference.init_point;
    await db
      .from('xmas_orders')
      .update({ mp_preference_id: preference.id, mp_init_point: initPoint })
      .eq('id', order.id);

    return json({ init_point: initPoint });
  } catch (e) {
    console.error(e);
    return json({ error: 'error_interno', detail: String((e as Error).message ?? e) }, 500);
  }
});
