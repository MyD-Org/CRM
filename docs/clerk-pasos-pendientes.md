# Clerk en el CRM — pasos pendientes

> Estado al 2026-08-11. El **código** de esta rama está terminado; lo que falta
> es configuración en paneles externos. Son los mismos pasos que ya se
> ejecutaron en el Shop, así que hay un precedente que funciona: cuando algo no
> cierre, comparar contra cómo quedó en la app `Central Led` de Clerk.

## Contexto: por qué dos aplicaciones de Clerk

Se evaluó una sola instancia con **satellite domains** —un login compartido
entre tienda y CRM— y se descartó: en producción los satellite domains
**requieren plan pago** (~USD 25/mes).

Consecuencia asumida, y conviene tenerla presente porque explica el resto del
diseño: los `clerkUserId` de los dos sistemas **no se corresponden**. La misma
persona es un usuario distinto en cada uno y entra por separado. Por eso el CRM
tiene su propia tabla `portal_client_links` en vez de leer la del Shop.

| | Aplicación de Clerk | Estado |
|---|---|---|
| Shop | `Central Led` | Producción lista sobre `centralled.com.ar` |
| CRM | `Portal Central Led` | **Solo desarrollo** — falta todo lo de abajo |

## Lo que ya está hecho (esta rama)

- `src/proxy.ts` — `clerkMiddleware()` compuesto con la resolución de tenant y
  el site gate. Next 16 admite **una sola** función proxy, y el orden importa:
  tenant → gate → Clerk. Clerk arma la respuesta final con el `x-tenant-id`
  adentro.
- `src/lib/portal-auth.ts` — identidad del portal, con match automático por
  email verificado contra el ERP.
- `portal_client_links` + migración `0019` (escrita a mano; ver más abajo).
- Páginas propias de login y el caso "sin cuenta".
- Se eliminó el OTP viejo (`/api/auth/send-code` y `verify-code`), que **no
  tenía canal de entrega**: en producción el código no llegaba a nadie y en
  desarrollo volvía en la respuesta HTTP, así que cualquiera podía entrar
  escribiendo el CUIT de otro.

## 1. Crear la instancia de producción de Clerk

En el dashboard de la app **Portal Central Led** → botón **"Go to prod"**.

Elegir **"Clone development instance"**: copia la configuración ya probada
(Google y Email habilitados) en vez de arrancar de cero.

> Clona la **configuración**, no los usuarios. Las cuentas de prueba quedan en
> la instancia de desarrollo.

## 2. Registros DNS

> ### ⚠️ El dominio primario del CRM es `crm.centralled.com.ar`
>
> **No `centralled.com.ar`.** Ese ya lo tomó la instancia del Shop, que creó
> `clerk.centralled.com.ar`, `accounts.centralled.com.ar`, `clkmail.…` y los dos
> `_domainkey`. Cargar los del CRM sobre el mismo dominio **pisaría esos
> registros y rompería el login de la tienda**.
>
> Con `crm.centralled.com.ar` como dominio primario, Clerk pide
> `clerk.crm.centralled.com.ar`, `accounts.crm.centralled.com.ar`, etc. — no
> colisionan con los del Shop y las dos instancias conviven en la misma zona.
>
> Al crear la instancia de producción, Clerk pregunta el dominio: escribir
> **`crm.centralled.com.ar`**.

Clerk pide 5 CNAME. Se cargan en **DonWeb** (`micuenta.donweb.com` → el dominio
→ Nameservers y Zona DNS), **no en Vercel**: el dominio tiene nameservers de
terceros (`ns1/ns2.donweb.com`).

Dos detalles que hicieron perder tiempo la vez anterior:

- DonWeb pide el **nombre completo** (`clerk.crm.centralled.com.ar`), no solo el
  subdominio.
- El TTL más bajo que ofrece es **900**.

Los valores exactos los da la pantalla de Clerk — **copiarlos, no tipearlos**:
tres de los cinco llevan un hash único de la instancia. En el Shop, un `cleck`
en vez de `clerk` costó una vuelta entera.

Verificar antes de apretar "Verify configuration" en Clerk:

```bash
for h in clerk accounts clkmail clk._domainkey clk2._domainkey; do
  echo "$h → $(dig +short CNAME "$h.crm.centralled.com.ar" @ns1.donweb.com)"
done
```

### Si falla la emisión del certificado SSL

Pasó en el Shop y **se resolvió solo**. Clerk verifica el DNS contra el
nameserver autoritativo, pero Let's Encrypt valida desde resolvers **públicos**;
si se verifica apenas cargados los registros, la emisión falla porque todavía no
propagaron. El reintento automático la levanta.

Antes de escalar a soporte, descartar:

```bash
# 1) ¿Hay CAA que bloquee la CA? (esto NO se arregla solo)
dig +short CAA centralled.com.ar @ns1.donweb.com

# 2) ¿Resuelve públicamente?
dig +short CNAME clerk.crm.centralled.com.ar @8.8.8.8
dig +short CNAME clerk.crm.centralled.com.ar @1.1.1.1
```

Para probar el TLS salteando la caché negativa del resolver local —que da falsos
"could not resolve host":

```bash
ip=$(dig +short clerk.crm.centralled.com.ar @8.8.8.8 | grep -E '^[0-9]' | head -1)
curl -sS -o /dev/null -w "%{http_code}\n" --resolve "clerk.crm.centralled.com.ar:443:$ip" \
  https://clerk.crm.centralled.com.ar/v1/health
```

## 3. Google OAuth propio

En producción Clerk **no presta** sus credenciales compartidas.

1. Google Cloud Console → **APIs y servicios → Pantalla de consentimiento**.
   - Tipo: **Externo**
   - Nombre de la app: **Central LED** ← es lo que lee el cliente
   - Dominio autorizado: `centralled.com.ar`
2. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**.
   - URI de redireccionamiento: la que muestra la pantalla de Clerk, con el
     formato `https://clerk.crm.centralled.com.ar/v1/oauth_callback`
   - Es un **cliente OAuth distinto** del que usa el Shop: otra instancia de
     Clerk, otra URI de redirección. Puede vivir en el mismo proyecto de Google
     Cloud y reusar la misma pantalla de consentimiento.
3. Pegar Client ID y Client Secret en Clerk → SSO connections → Google.

> **Clerk no tiene botón de guardar** en esa pantalla: guarda al salir del campo.
> Cerrar la pestaña con el cursor todavía dentro del input pierde el valor — pasó
> en el Shop y hubo que rehacerlo.

### El paso que rompe el login sin avisar

Google Cloud → **Público** → si dice **"Prueba"**, tocar **"Publicar app"**.

En modo prueba **solo entran los usuarios de una lista blanca**. Con la lista
vacía no entra nadie, el login se ve perfecto y el error no explica el motivo.

Con scopes básicos (`openid`, email, perfil) publicar es inmediato: no hay
revisión de Google.

## 4. Variables de entorno

En Vercel, proyecto `crm`:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   pk_live_...   (Production)
CLERK_SECRET_KEY                    sk_live_...   (Production)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   pk_test_...   (Preview)
CLERK_SECRET_KEY                    sk_test_...   (Preview)
NEXT_PUBLIC_CLERK_SIGN_IN_URL       /portal/ingresar
NEXT_PUBLIC_CLERK_SIGN_UP_URL       /portal/ingresar
```

Dos cuidados que costaron un rato en el Shop:

- **Las claves de desarrollo no van a producción.** Una instancia `pk_test_`
  muestra el cartel "Development mode" al cliente y acepta cualquier origen.
- Al pegar las nuevas en `.env.local`, **revisar que no queden duplicadas** con
  las de test. En un archivo `.env` gana la última, así que el dev local
  terminaría apuntando a la instancia de producción, que no funciona en
  `localhost`.

## 5. Migraciones

**Este repo usa SQL escrito a mano, no `drizzle-kit generate`.**

Los snapshots de drizzle quedaron congelados en `0013` mientras las migraciones
`0014`–`0019` se escribieron a mano. Por eso `npm run db:generate` pide resolver
un conflicto viejo (`tenants.business_hours`) y no se puede correr sin
intervención manual.

Para agregar una tabla: escribir el `.sql`, agregar la entrada al
`drizzle/meta/_journal.json` y correr `npm run db:migrate`.

La `0019` (tabla `portal_client_links`) ya está aplicada.

## Lo que NO entra en esta rama

- **Portal de clientes en el CRM**: se discutió mover facturas y saldo al Shop
  para que el cliente tenga una sola cara y el CRM quede como backoffice puro.
  Quedó sin decidir.
- El admin (`/admin`) sigue con su login propio de iron-session. Son otro
  público —operadores, no clientes— y no comparten sesión con la tienda.
