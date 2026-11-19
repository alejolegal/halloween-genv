// =====================================================================
//  Edge Function: mp-webhook   (archivo autocontenido: se puede pegar
//  tal cual en Supabase > Edge Functions > Deploy a new function > Via Editor)
//
//  Recibe los avisos de Mercado Pago y habilita la entrada automáticamente
//  cuando el pago queda aprobado.
//
//  IMPORTANTE: en la configuración de esta función DESACTIVAR
//  "Enforce JWT Verification" (Mercado Pago no manda token de Supabase).
//
//  Secrets: MP_ACCESS_TOKEN (obligatorio), MP_WEBHOOK_SECRET (recomendado:
//  la "clave secreta" que muestra Mercado Pago al configurar el webhook).
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function env(name: string): string {
  const v = Deno.env.get(name) ?? '';
  if (!v) throw new Error(`Falta el secret ${name}`);
  return v;
}

/** Verifica la firma x-signature de Mercado Pago (si hay secreto configurado). */
async function validSignature(req: Request, dataId: string): Promise<boolean> {
  const secret = Deno.env.get('MP_WEBHOOK_SECRET');
  if (!secret) return true; // igual se valida consultando el pago a la API

  const parts = Object.fromEntries(
    (req.headers.get('x-signature') ?? '').split(',').map((p) => p.split('=').map((s) => s.trim())),
  );
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${req.headers.get('x-request-id') ?? ''};ts:${ts};`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: true });

  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const type = body.type ?? body.topic ?? url.searchParams.get('type') ?? url.searchParams.get('topic');
    const dataId = String(body?.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id') ?? '');

    if (type !== 'payment' || !dataId) return json({ ok: true, ignored: true });

    if (!(await validSignature(req, dataId))) {
      console.warn('Firma inválida en webhook de Mercado Pago');
      return json({ ok: false, error: 'invalid_signature' }, 401);
    }

    // Nunca se confía en el aviso: se consulta el pago real a Mercado Pago
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`, {
      headers: { Authorization: `Bearer ${env('MP_ACCESS_TOKEN')}` },
    });
    if (!res.ok) throw new Error(`Mercado Pago ${res.status}`);
    const payment = await res.json();

    if (!payment?.external_reference) return json({ ok: true, ignored: 'sin_referencia' });
    if (payment.currency_id && payment.currency_id !== 'ARS') return json({ ok: true, ignored: 'moneda' });

    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data, error } = await db.rpc('xmas_mp_register_payment', {
      p_order_id: payment.external_reference,
      p_payment_id: String(payment.id),
      p_status: String(payment.status),
      p_amount: Number(payment.transaction_amount ?? 0),
    });
    if (error) throw error;

    console.log('webhook payment', dataId, JSON.stringify(data));
    return json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return json({ ok: false }, 500); // 500 -> Mercado Pago reintenta más tarde
  }
});
