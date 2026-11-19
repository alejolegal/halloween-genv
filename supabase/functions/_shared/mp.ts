// Utilidades compartidas para Mercado Pago + Supabase (Deno / Edge Functions)
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function env(name: string, required = true): string {
  const v = Deno.env.get(name) ?? '';
  if (required && !v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export function adminClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
}

const MP_API = 'https://api.mercadopago.com';

export async function mpFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${MP_API}${path}`, {
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
  if (!res.ok) {
    throw new Error(`Mercado Pago ${res.status}: ${data?.message ?? text}`);
  }
  return data;
}

/**
 * Consulta el pago DIRECTAMENTE a la API de Mercado Pago (nunca se confía en
 * lo que llega por la URL o el body) y, si está aprobado y el monto coincide,
 * habilita la orden en la base de datos.
 */
export async function processPayment(db: SupabaseClient, paymentId: string) {
  const payment = await mpFetch(`/v1/payments/${encodeURIComponent(paymentId)}`);
  const orderId: string | undefined = payment?.external_reference;
  if (!orderId) return { ok: false, reason: 'sin_external_reference' };

  if (payment.currency_id && payment.currency_id !== 'ARS') {
    return { ok: false, reason: 'moneda_invalida' };
  }

  const { data, error } = await db.rpc('xmas_mp_register_payment', {
    p_order_id: orderId,
    p_payment_id: String(payment.id),
    p_status: String(payment.status),
    p_amount: Number(payment.transaction_amount ?? 0),
  });
  if (error) throw error;
  return data;
}

/** Verificación de la firma x-signature de los webhooks de Mercado Pago. */
export async function verifyMpSignature(req: Request, dataId: string): Promise<boolean> {
  const secret = Deno.env.get('MP_WEBHOOK_SECRET');
  if (!secret) return true; // sin secreto configurado: se valida igual consultando la API

  const signature = req.headers.get('x-signature') ?? '';
  const requestId = req.headers.get('x-request-id') ?? '';
  const parts = Object.fromEntries(
    signature.split(',').map((p) => p.split('=').map((s) => s.trim()) as [string, string]),
  );
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${requestId};ts:${ts};`;

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
