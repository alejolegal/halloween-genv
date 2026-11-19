# 🎄 NAVIDAD · Gen V Christmas Edition — venta de anticipadas

Web estática (HTML + CSS + JS) con base de datos y pagos en **Supabase** y **Mercado Pago**.

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Web pública: tandas en vivo, compra, "Mis entradas" |
| `staff.html` | Panel del equipo: aprobar transferencias, clientes, escáner QR en puerta |
| `js/config.js` | **Único archivo a editar**: fecha, lugar, datos bancarios, WhatsApp |
| `supabase/migrations/001_navidad_schema.sql` | Base de datos completa (tablas, seguridad, lógica de tandas) |
| `supabase/functions/` | Integración con Mercado Pago (checkout + webhook) |

## Cómo funciona

- **Tandas**: Navideña de Regalo (25 × $6.000) → Tanda 1 ($10.000) → Tanda 2 ($12.000) → Tanda 3 ($15.000).
  Cuando una se agota, la siguiente se habilita sola. Si alguien compra 4 y quedan 2 en la tanda actual,
  2 se cobran a ese precio y 2 al de la siguiente (nunca se sobrevende una tanda).
- **FOMO real**: la web muestra entradas vendidas, cuántas quedan, la tanda actual, los SOLD OUT y avisa
  en vivo cuando alguien compra o cuando cambia de tanda. Todos los números salen de la base de datos.
- **Solo descuentan las aprobadas**: una compra pendiente no ocupa cupo. La entrada se cuenta cuando la aprobás
  vos (transferencia) o cuando Mercado Pago acredita el pago. Si al aprobar la tanda ya está llena, el panel te avisa.
- **Recargo Mercado Pago**: en el panel → Resumen ponés la comisión (%) y la web la suma solo a quien paga con MP.
- **Mercado Pago**: se habilita automáticamente al acreditarse el pago (webhook + verificación al volver a la web).
- **Transferencia**: el comprador envía el comprobante por WhatsApp y vos aprobás en `staff.html` → *Transferencias*.
- **Entradas nominales**: cada entrada tiene nombre, DNI y su propio QR. Un DNI no puede tener dos entradas.
- **Puerta**: el staff escanea el QR con el celular o busca por DNI. Cada entrada se usa una sola vez aunque
  haya varios celulares escaneando. Si se cae internet, sigue validando con la copia local y sincroniza después.

## Puesta en marcha (una sola vez)

### 1. Base de datos
1. Entrá a Supabase → tu proyecto → **SQL Editor** → *New query*.
2. Pegá todo `supabase/migrations/001_navidad_schema.sql` y tocá **Run**.
   Después, en otra *New query*, pegá `supabase/migrations/002_solo_aprobadas_y_recargo_mp.sql` y tocá **Run**
   (las reservas no descuentan entradas y se agrega el recargo configurable de Mercado Pago).
3. Revisá cupos/precios en **Table Editor → `xmas_tiers`** (por defecto Tandas 1, 2 y 3 tienen **100 cupos** cada una — ajustalo).

### 2. Usuarios del staff
1. **Authentication → Users → Add user** (email + contraseña) para vos y para cada persona de puerta.
2. En el SQL Editor:
   ```sql
   insert into public.xmas_staff (user_id, role, name)
   select id, 'admin', 'Alejo' from auth.users where email = 'TU_EMAIL';

   insert into public.xmas_staff (user_id, role, name)
   select id, 'door', 'Puerta 1' from auth.users where email = 'EMAIL_PUERTA';
   ```
   `admin` ve todo. `door` solo ve la pestaña Puerta (escanear y dar ingreso).
3. En **Authentication → Providers → Email** desactivá "Allow new users to sign up" para que nadie más pueda crearse un usuario.

### 3. Mercado Pago
1. En [Mercado Pago Developers](https://www.mercadopago.com.ar/developers/panel/app) creá una aplicación
   (Checkout Pro) y copiá el **Access Token de producción**.
2. Supabase → **Edge Functions → Secrets** → agregá:
   - `MP_ACCESS_TOKEN` = el Access Token de producción (empieza con `APP_USR-`)
   - `SITE_URL` = la dirección pública de la web (ej. `https://alejolegal.com`)
   - `EVENT_NAME` = `Navidad Gen V`
3. Supabase → **Edge Functions → Deploy a new function → Via Editor**:
   - Nombre `mp-checkout`: pegá todo `supabase/functions/mp-checkout/index.ts` y tocá **Deploy**.
   - Nombre `mp-webhook`: pegá todo `supabase/functions/mp-webhook/index.ts` y tocá **Deploy**.
     Después, en los **Details/Settings** de `mp-webhook`, **desactivá "Enforce JWT Verification"** y guardá.
4. En tu aplicación de Mercado Pago → **Webhooks** → URL de producción:
   `https://anubyojemmaybrcmzqdo.supabase.co/functions/v1/mp-webhook`, evento **Pagos**.
   Copiá la **clave secreta** que te muestra y agregala en Supabase → Edge Functions → Secrets como `MP_WEBHOOK_SECRET`.

> Con Mercado Pago se compra **de a 1 entrada** por operación (lo valida la web y la base de datos).
> Para 2 a 4 entradas, el comprador usa transferencia.

(Alternativa para quien use la terminal: `supabase functions deploy mp-checkout` y
`supabase functions deploy mp-webhook --no-verify-jwt`.)

### 4. Datos del evento
Editá `js/config.js`: **fecha y hora, lugar**, datos de transferencia, WhatsApp que recibe comprobantes,
y links opcionales (grupo de WhatsApp, playlist, Instagram — si quedan vacíos no se muestran).

### 5. Probar sin tocar datos reales
Abrí `index.html?demo=1` y `staff.html?demo=1`: funciona todo con datos de prueba guardados en tu navegador
(en el panel demo cualquier email entra; si contiene "puerta" entra con rol de puerta). `?demo=0` vuelve al modo real.

### 6. Publicar
Subí los archivos a GitHub Pages / tu hosting como siempre. El panel está en `/staff.html`.

## Seguridad
- El navegador del público **no puede** leer ni modificar órdenes: solo usa funciones controladas
  (crear orden, ver disponibilidad, ver sus entradas por DNI). Teléfonos y emails nunca se exponen.
- Precios, cupos y aprobaciones se calculan en la base de datos, no en el navegador.
- Mercado Pago se verifica consultando el pago real a su API (y la firma del webhook).
- ⚠️ **Proyecto de Halloween**: la tabla vieja `orders` permitía que cualquiera con la clave pública
  aprobara órdenes desde la consola del navegador. Si ya no la usás, desactivá su acceso:
  ```sql
  alter table public.orders enable row level security;
  revoke all on public.orders from anon, authenticated;
  ```
