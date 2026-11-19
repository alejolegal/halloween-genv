// =====================================================================
//  Edge Function: mp-checkout   (archivo autocontenido: se puede pegar
//  tal cual en Supabase > Edge Functions > Deploy a new function > Via Editor)
//
//   POST { action: 'create', code, dni }              -> { init_point }
//   POST { action: 'verify', code, dni, payment_id }  -> { status }
//
//  'create' arma el pago de Mercado Pago para una orden pendiente.
//  'verify' se usa al volver de Mercado Pago: consulta el pago real a la
//  API y habilita la entrada al instante (sin esperar el webhook).
//
//  Secrets necesarios (Edge Functions > Secrets):
//    MP_ACCESS_TOKEN  -> Access Token de PRODUCCIÓN de Mercado Pago
//    SITE_URL         -> URL pública de la web (ej: https://alejolegal.com)
//    EVENT_NAME       -> (opcional) nombre que ve el comprador en MP
//  SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase solo.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

function env(name: string): string {
  const v = Deno.env.get(name) ?? '';
  if (!v) throw new Error(`Falta el secret ${name}`);
  return v;
}

async function mpFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${data?.message ?? text}`);
  return data;
}

// Mercado Pago espera fechas con offset (ej: 2026-12-20T21:00:00.000-03:00)
function toArgentinaIso(date: Date): string {
  return new Date(date.getTime() - 3 * 60 * 60 * 1000).toISOString().replace('Z', '-03:00');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const code = String(body.code ?? '').trim().toUpperCase();
    const dni = String(body.dni ?? '').replace(/\D/g, '');
    if (!code || !dni) return json({ error: 'datos_incompletos' }, 400);

    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
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
          const p = await mpFetch(`/v1/payments/${paymentId}`);
          // Solo se acepta un pago que pertenezca a ESTA orden
          if (p?.external_reference === order.id && (!p.currency_id || p.currency_id === 'ARS')) {
            await db.rpc('xmas_mp_register_payment', {
              p_order_id: order.id,
              p_payment_id: String(p.id),
              p_status: String(p.status),
              p_amount: Number(p.transaction_amount ?? 0),
            });
          }
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

    const items = (order.xmas_tickets ?? []).map((t: any, i: number) => ({
      id: `${order.code}-${i + 1}`,
      title: `Entrada ${eventName} · ${t.xmas_tiers?.name ?? 'General'}`,
      quantity: 1,
      unit_price: t.price,
      currency_id: 'ARS',
    }));

    const [firstName, ...rest] = String(order.buyer_name).split(' ');
    const preference = await mpFetch('/checkout/preferences', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': order.id },
      body: JSON.stringify({
        items,
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
        binary_mode: true, // aprobado o rechazado al instante
        statement_descriptor: 'NAVIDAD GENV',
        expires: true,
        expiration_date_to: toArgentinaIso(new Date(order.expires_at)),
        metadata: { order_code: order.code },
      }),
    });

    await db
      .from('xmas_orders')
      .update({ mp_preference_id: preference.id, mp_init_point: preference.init_point })
      .eq('id', order.id);

    return json({ init_point: preference.init_point });
  } catch (e) {
    console.error(e);
    return json({ error: 'error_interno', detail: String((e as Error).message ?? e) }, 500);
  }
});
