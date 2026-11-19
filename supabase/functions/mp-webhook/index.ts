// Edge Function: mp-webhook
// Recibe las notificaciones de Mercado Pago y habilita las entradas
// automáticamente cuando un pago queda aprobado.
// Desplegar SIN verificación JWT (Mercado Pago no envía token de Supabase):
//   supabase functions deploy mp-webhook --no-verify-jwt
import { adminClient, json, processPayment, verifyMpSignature } from '../_shared/mp.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: true });

  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));

    const type = body.type ?? body.topic ?? url.searchParams.get('type') ?? url.searchParams.get('topic');
    const dataId = String(body?.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id') ?? '');

    if (type !== 'payment' || !dataId) {
      return json({ ok: true, ignored: true });
    }

    if (!(await verifyMpSignature(req, dataId))) {
      console.warn('Firma inválida en webhook de Mercado Pago');
      return json({ ok: false, error: 'invalid_signature' }, 401);
    }

    const result = await processPayment(adminClient(), dataId);
    console.log('webhook payment', dataId, JSON.stringify(result));
    return json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    // 500 -> Mercado Pago reintenta la notificación más tarde
    return json({ ok: false }, 500);
  }
});
