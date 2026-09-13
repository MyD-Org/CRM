## Exploration: comprobantes-de-pago

Base: `main` (b13184b). Solo lectura: no se tocó código, DB, env ni el bucket.

### HALLAZGO QUE CAMBIA LA ARQUITECTURA

**Vercel Functions NO aceptan bodies de 100 MB: el límite es 4,5 MB** (request y response), 413 `FUNCTION_PAYLOAD_TOO_LARGE`. Verificado en https://vercel.com/docs/functions/limitations (last_updated 2026-08-24). El dato de "100 MB" del brief es incorrecto. Con máximo de 20 MB, **un multipart a un Route Handler no funciona en prod** (en local sí, que es lo peor: pasa en dev y rompe en Vercel).

Segundo bloqueo independiente: `src/proxy.ts` matchea `/api/*` y en esta versión de Next el proxy **bufferea el body con tope `experimental.proxyClientMaxBodySize` = 10 MB por default y, si se pasa, TRUNCA en silencio** (sin error; `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`). Irrelevante si el archivo no pasa por la función, pero hay que saberlo si alguien intenta el multipart.

⇒ El archivo tiene que ir **del navegador directo a R2 con URL prefirmada (PUT)**, y la función solo firma, valida y procesa leyendo desde R2 (bajar 20 MB desde una función no está limitado; lo limitado es el body entrante/saliente de la invocación).

### Current State

- **Portal**: sesión iron-session `portal-session` (`src/lib/session.ts`), `SessionData = { codigocliente, razonsocial, cuit, email, tipoCuenta, isLoggedIn }` (`src/types/index.ts`) → la razón social y el CUIT para el mail salen de la sesión, sin pegarle a Alegra. Rutas modelo: `src/app/api/portal/pagos/route.ts` (401 si `!isLoggedIn || !codigocliente`, `Cache-Control: private, no-store`) y `src/app/api/portal/documentos/[kind]/[id]/route.ts` (proxy de bytes para no filtrar URL firmada; 404 y no 403 para no confirmar existencia).
- **UI portal**: `src/components/portal/DashboardClient.tsx` → `PagosTable` (l.930) usa `Toolbar`, que ya tiene un slot `extraActions` "extremo derecho" con el comentario literal `(e.g. "Adjuntar comprobante")` (l.~1662) — el lugar del botón existe. `AdjuntarModal` fake se borró en 451fb77 (hacía `alert("Envío: próximamente")`, tenía file drop + select de facturas).
- **UI kit** `@myd-org/ui` 0.9.x: `FileDropZone({file,onChange,accept,hint})`, `Dialog`, `Field`, `Select`, `Input`, `Button`, `Tabs`, `Table`, `Badge`, `useToast`, `DateRangeField`.
- **Email**: `src/lib/email.ts` `sendEmail(tenant,to,subject,html,text?)` → `from: tenant.resendFrom`, sin attachments, dry-run sin `RESEND_API_KEY`, lanza si Resend rechaza. SDK `resend` 6.12 soporta `attachments: {content: Buffer|string, filename, contentType}[]`, `replyTo`, `tags`. **Límite Resend: 40 MB por mail después de base64** (20 MB → ~26,7 MB, entra).
- **Admin**: guard fuerte `getGuardedAdminSession(req?)` en `src/lib/admin-session.ts` (host→tenant, fila en DB, rol fresco, `passwordHash` no nulo). **Hoy solo lo usa `src/app/admin/(protected)/layout.tsx`**: TODAS las rutas `src/app/api/admin/**` leen `session.tenantId`/`session.role` crudos de la cookie (ej. `settings/schedule`, `catalog/upload`). Las rutas nuevas deberían usar el guard (tenant del host + rol de la DB) y no copiar el patrón viejo. Página modelo con rol: `configuracion/page.tsx` (`roleRank(session.role) < 1 → notFound()`). Nav en `src/components/admin/AdminShell.tsx` (`NAV` con `minRole`). Roles en `src/lib/roles.ts` (operator 0 / admin 1 / superadmin 2).
- **Config**: `ConfiguracionShell` tiene tabs `catalogo` (superadmin) y `horarios` (admin+). Ruta de settings modelo: `src/app/api/admin/settings/schedule/route.ts` (GET/PUT sobre `tenants` filtrando por `session.tenantId`).
- **Tenant**: `tenants` en `src/db/schema.ts` (l.22). `resend_from` = remitente, `legal_email` = contacto legal. **No hay columna para el destino de comprobantes**. `TenantConfig` (`src/lib/tenants.ts`) se arma en `getTenantByIdFromDb` campo por campo (y hay un fallback por env en `buildTenantConfig`).
- **Rate limit**: patrón Map en memoria por proceso en `src/app/api/auth/send-code/route.ts` (ventana deslizante, clave `${tenant.id}:${id}`, 429).
- **Storage**: el CRM no tiene nada. ai-api: `src/storage/r2.ts` con `aws4fetch` (`AwsClient`, región `auto`, service `s3`, endpoint `https://{account}.r2.cloudflarestorage.com/{bucket}/{key}`), `putObject` que devuelve boolean, `signedGetUrl` con `signQuery` y TTL 1 h (razonado: TTL corto rompía abrir en pestaña nueva), key con prefijo que decide la lifecycle rule y tenant adentro. Config "las 4 o ninguna" en `ai-api/src/config.ts`. En el `.env` del CRM hay además un `R2_TOKEN` que el código de ai-api no usa (ruido: no copiarlo).
- **Visor admin reutilizable**: `src/components/admin/MessageAttachments.tsx` (imagen/PDF, estados "no disponible" vs "no se pudo cargar", `useStableUrl` para no remontar por URL firmada nueva en cada poll).
- **HEIC**: `sharp` 0.34.5 viene transitivo de `next` (no es dep directa). Verificado local: `sharp.format.heif.input.fileSuffix = [".avif"]` → **no decodifica HEIC/HEVC**. `heic-convert` 2.1.0 (último publish 2023-11) = `heic-decode` (→ `libheif-js` 1.23, ~8,8 MB desempaquetado, wasm/asm.js) + `jpeg-js` (encoder JPEG en JS puro, lento).
- **Migraciones**: próxima `drizzle/0023_*.sql` a mano + entrada en `_journal.json` (idx 23), estilo 0022 (comentario "APLICAR EN PROD ANTES DE MERGEAR", `IF NOT EXISTS`).
- **Tests**: `test/integration/tenant-isolation.integration.test.ts` y `helpers.ts` (`seedTenant`, `truncateAll`; ojo que `seedOperator` siembra hash inválido).

### Affected Areas

Crear:
- `drizzle/0023_payment_receipts.sql` + `drizzle/meta/_journal.json` — tabla nueva + columna de tenant.
- `src/db/schema.ts` — `paymentReceipts` + `tenants.receiptsEmail`.
- `src/lib/r2.ts` — port de `ai-api/src/storage/r2.ts`: `r2Config()` (las 4 o ninguna), `signedPutUrl(key, contentType, contentLength, ttl)`, `signedGetUrl`, `getObject`, `putObject`, `deleteObject`, `headObject`. Dep nueva `aws4fetch`.
- `src/lib/receipt-file.ts` — sniff por magic bytes, normalización/conversión HEIC→JPG, nombre saneado (unit-testeable puro).
- `src/lib/receipt-email.ts` — builder `{subject, html, text}` (patrón `src/lib/otp-email.ts`) con escape HTML de todo lo que viene del cliente.
- `src/app/api/portal/comprobantes/route.ts` — `POST` inicia (valida metadatos, crea fila `uploading`, devuelve URL prefirmada PUT) y opcional `GET` (lista del cliente, "ya lo mandé").
- `src/app/api/portal/comprobantes/[id]/confirm/route.ts` — `POST`: HEAD/GET del objeto, sniff, conversión, key final, mail, estado.
- `src/app/admin/(protected)/comprobantes/page.tsx` + componente cliente (tabla con filtro pendiente/cargado).
- `src/app/api/admin/comprobantes/route.ts` (GET lista paginada), `src/app/api/admin/comprobantes/[id]/route.ts` (PATCH marcar cargado/deshacer), `src/app/api/admin/comprobantes/[id]/file/route.ts` (GET: redirect a URL firmada corta o proxy de bytes), opcional `[id]/resend-email`.
- `src/app/api/admin/settings/receipts/route.ts` (GET/PUT del mail destino) o ampliar una ruta de "datos del negocio".
- Tests: unit de `receipt-file` (magic bytes, nombres), `r2` (firma con fetch mockeado), rutas; integración de aislamiento (admin de A no lista/abre/marca comprobantes de B).

Cambiar:
- `src/components/portal/DashboardClient.tsx` — botón "Informar pago" en `extraActions` del `Toolbar` de `PagosTable` + modal nuevo (no resucitar el viejo: pedía facturas).
- `src/lib/email.ts` — `sendEmail` con opciones `{ attachments?, from?, replyTo? }` (hoy el `from` es siempre `tenant.resendFrom`; acá tiene que ser `comprobantes@example.com`). Mantener firma compatible (objeto opcional al final).
- `src/lib/tenants.ts` — `TenantConfig.receiptsEmail` en `getTenantByIdFromDb` (y `""` en el fallback de env).
- `src/components/admin/AdminShell.tsx` — entrada "Comprobantes" en `NAV` (icono `Receipt`), `minRole` a definir.
- `src/components/admin/ConfiguracionShell.tsx` + `configuracion/page.tsx` — campo "Email para comprobantes" (tab nuevo "Comprobantes"/"Notificaciones", admin+).
- `package.json` — `aws4fetch`, `heic-decode` (o `heic-convert`), `sharp` como dep directa.
- Bucket `crm-portal` (config de Cloudflare, no código): **CORS** para PUT desde los orígenes del portal + **lifecycle** sobre el prefijo temporal.
- `docs/FUNCIONALIDADES.md`.

### Modelo de datos propuesto

```sql
-- 0023_payment_receipts.sql
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "receipts_email" text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS "payment_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  "codigocliente" text NOT NULL,          -- id de contacto Alegra (de la sesión, nunca del body)
  "razonsocial" text NOT NULL,            -- snapshot al informar (el admin no le pega a Alegra)
  "cuit" text NOT NULL DEFAULT '',
  "amount" numeric(14,2) NOT NULL,        -- > 0
  "currency" text NOT NULL DEFAULT 'ARS',
  "paid_on" date NOT NULL,                -- fecha del pago (no futura, no absurda)
  "method" text NOT NULL,                 -- 'transferencia'|'cheque'|'efectivo'|'otro' (CHECK)
  "method_other" text,                    -- detalle si method='otro'
  "notes" text,                           -- opcional, texto libre acotado
  "status" text NOT NULL DEFAULT 'uploading', -- 'uploading'|'pending'|'loaded' (CHECK)
  "file_key" text,                        -- key final en crm-portal (null mientras uploading)
  "file_mime" text,                       -- mime REAL (sniffeado/convertido)
  "file_size" integer,
  "file_original_name" text,              -- saneado, solo informativo
  "file_sha256" text,                     -- dedup / auditoría
  "converted_from" text,                  -- 'image/heic' si hubo conversión
  "email_status" text NOT NULL DEFAULT 'pending', -- 'pending'|'sent'|'failed'|'skipped'
  "email_error" text,
  "email_sent_at" timestamptz,
  "loaded_at" timestamptz,
  "loaded_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "loaded_by_name" text,                  -- snapshot: sobrevive a borrar el usuario
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "submitted_at" timestamptz              -- cuando pasó a pending
);
CREATE INDEX IF NOT EXISTS "pr_tenant_status_created" ON "payment_receipts" ("tenant_id","status","created_at");
CREATE INDEX IF NOT EXISTS "pr_tenant_cliente_created" ON "payment_receipts" ("tenant_id","codigocliente","created_at");
```
- Aislamiento: toda query admin `WHERE tenant_id = <tenant del guard> AND id = ...` (nunca `id` solo); toda query portal `WHERE tenant_id AND codigocliente = session.codigocliente`. Respuesta 404 para ajeno.
- `uploading` nunca aparece en admin; filas `uploading` viejas (> 1 día) se limpian (cron existente o lazy).
- "Deshacer cargado" (loaded → pending) conviene permitirlo registrando quién (o una tabla de eventos si se quiere historial completo; con `loaded_by/at` alcanza para v1).

**Layout de keys en `crm-portal`** (primer segmento = lifecycle rule, como ai-api):
- `tmp/receipts/{tenantId}/{receiptId}` — destino del PUT del navegador; lifecycle: borrar a 1 día. Sin extensión ni nombre del cliente.
- `receipts/{tenantId}/{yyyy-mm}/{receiptId}.{pdf|jpg|png|webp}` — final, sin expiración (es un respaldo contable; retención a definir).
- Nunca el nombre original ni el `codigocliente` en la key (el bucket no debería tener PII en rutas).

### Flujo de subida recomendado (en esta versión de Next + Vercel)

1. **POST `/api/portal/comprobantes`** (JSON chico): sesión portal → rate limit → valida `amount`, `paid_on`, `method`, `fileName`, `fileSize` (≤ 20 MB, >0), `contentType` declarado ∈ {pdf, jpeg, png, webp, heic, heif}. Crea fila `uploading` y devuelve `{ id, uploadUrl, headers }` con URL PUT prefirmada (aws4fetch `signQuery`, TTL ~5-10 min) **firmando `content-type` y `content-length`** para que R2 rechace otro tamaño. (R2 no soporta POST policy con `content-length-range`, así que el tope se firma en el header y se re-verifica en el paso 3.)
2. **Navegador → PUT directo a R2** con `fetch` (progreso con XHR si se quiere barra). Requiere CORS del bucket (`PUT` desde los orígenes del portal, headers `content-type`). La key no depende de nada que mande el cliente.
3. **POST `/api/portal/comprobantes/[id]/confirm`**: verifica fila `(tenant, codigocliente, id, status='uploading')` → `HEAD` (tamaño real ≤ 20 MB, si no borra y 413) → `GET` del objeto → **sniff por magic bytes** de los primeros bytes:
   - PDF `%PDF-` (25 50 44 46 2D); JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; WebP `RIFF....WEBP`; HEIC/HEIF `....ftyp` + brand `heic|heix|hevc|heim|heis|mif1|msf1`. Cualquier otra cosa (incluido SVG/HTML aunque diga `image/*`) → rechazo, borrar tmp, 415.
   - Mime final = el sniffeado, nunca el declarado ni la extensión.
   - HEIC → decodificar + JPEG (ver abajo). Imágenes JPEG/PNG: opcionalmente pasar por `sharp().rotate()` para **strip de EXIF (GPS del celular)**; PDF se guarda tal cual.
   - PUT a la key final, DELETE del tmp, `status='pending'`, `submitted_at`.
   - Recién ahí el mail (paso 4). Idempotente: si se reintenta el confirm con fila ya `pending`, devolver OK sin re-mandar.
4. **Mail**: ver sección Email. El fallo del mail NO revierte nada.
- Filename: solo informativo; `normalize('NFKD')`, quitar diacríticos/control/`/\\:*?"<>|`, colapsar a `[\w.-]`, máx ~80 chars, extensión re-derivada del mime real. Para servir: `Content-Disposition` con `filename="comprobante-{fecha}-{id8}.{ext}"` generado, no el del cliente.
- `export const maxDuration = 60` en confirm (hay antecedentes con `300` en `catalog/sync`) y `runtime` Node (default).

**HEIC → JPG, dónde y con qué**
- El navegador de iPhone ya convierte HEIC→JPEG solo cuando el `<input accept>` lista tipos concretos (`image/jpeg,image/png,application/pdf`) en vez de `image/*` o `image/heic` → poner ese `accept` baja mucho la frecuencia. El HEIC real llega igual desde Mac/Files/AirDrop, así que la conversión server-side sigue haciendo falta.
- `sharp` estándar no sirve (verificado). Opciones:
  - `heic-convert` tal cual: decode wasm + encode `jpeg-js` en JS puro. Para una foto de 12 MP: RGBA crudo ~48 MB + heap wasm; el encode en JS es la parte lenta (orden de segundos, CPU activa facturada). Funciona pero es la opción cara.
  - **`heic-decode` + `sharp` para encodear** (recomendado): decode wasm → `sharp(raw, {raw:{width,height,channels:4}}).resize({width:2560, withoutEnlargement:true}).jpeg({quality:82, mozjpeg:true})`. Encode nativo, y el resize baja el adjunto a ~0,5-1,5 MB. Requiere declarar `sharp` como dep directa (hoy es transitiva de next).
  - Cliente (`heic2any`/libheif en el browser): ahorra servidor pero suma ~MBs de wasm al bundle del portal y confía en el cliente para el formato; descartado como única defensa.
- **Pendiente medir en un preview de Vercel** (no se pudo benchmarkear sin instalar paquetes): tiempo y memoria pico con 3-4 HEIC reales de iPhone (12 y 48 MP) y con 2-3 conversiones concurrentes (Fluid comparte la instancia entre requests → memoria sumada; default 2 GB). Poner un tope de píxeles (ej. rechazar > 50 MP) antes de decodificar para evitar bombas de descompresión.

### Email

- From `Comprobantes <comprobantes@example.com>` (dominio verificado de la plataforma), `to = tenant.receiptsEmail`, `replyTo = session.email` si existe (el operador contesta al cliente directo), subject fijo `[Comprobante de pago] {razonsocial} — ${monto} — {dd/mm/aaaa}`, `tags` para buscar en Resend (`type=payment_receipt`, `tenant`). **La dirección from no debe hardcodearse en el código (repo público: sin URLs/datos de prod)** → env `RECEIPTS_EMAIL_FROM` o columna; el dominio de plataforma no es un secreto pero el repo es genérico multi-tenant.
- Cuerpo: cliente, CUIT, monto, fecha, medio, notas (todo escapado), link al admin `/admin/comprobantes?id=...` (link relativo al host del tenant, no URL firmada: la firmada vencería y quedaría en el buzón).
- **Adjuntar vs link**: adjuntar el archivo final (post-conversión). Resend aguanta 40 MB post-base64 → 20 MB entra. PERO Outlook.com/Hotmail tiene su propio tope de tamaño de mensaje entrante (~20-25 MB con encoding, no verificado en este explore) → un PDF escaneado de 19 MB puede rebotar en el destino aunque Resend lo acepte. Recomendación: **adjuntar si el archivo final ≤ ~10 MB; si es más grande, mandar el mail sin adjunto con el aviso "el archivo pesa X MB, verlo en el backoffice"**. Con el resize de imágenes, el caso grande queda casi solo para PDFs.
- **Si falla el mail**: la fila ya está `pending` y es visible en admin; se guarda `email_status='failed'` + `email_error`; al cliente se le responde éxito ("recibimos tu comprobante") porque el dato está a salvo. Admin muestra badge "mail no enviado" + botón "Reenviar mail". Sin `RESEND_API_KEY` → `email_status='skipped'` (dry-run). Si `receiptsEmail` está vacío → `skipped` + aviso en admin/configuración. Vercel puede cortar la función si la respuesta ya salió: mandar el mail ANTES de responder (o `after()` de Next con la fila ya persistida; si `after` falla, queda `pending` y el admin lo ve igual).

### Seguridad

- **Auth en cada ruta**: portal → `getIronSession(sessionOptions)` + `isLoggedIn && codigocliente`; admin → `getGuardedAdminSession(req)` (no la cookie cruda como el resto de `/api/admin/**`), tenant del guard en TODOS los `WHERE`.
- **Aislamiento admin**: listado, detalle, archivo y PATCH filtran `tenant_id`; ajeno = 404. Test de integración con dos tenants. La key incluye `tenantId` y el endpoint de archivo la toma de la fila, nunca de la query.
- **Aislamiento portal**: `confirm` verifica `codigocliente` de la sesión contra la fila; el cliente nunca elige key.
- **Archivo en admin**: preferir **proxy de bytes** (patrón `documentos/[kind]/[id]`) con `Content-Type` = mime sniffeado, `X-Content-Type-Options: nosniff`, `Content-Disposition` controlado y `Cache-Control: private, no-store`… **pero** proxy está sujeto al límite de 4,5 MB de RESPONSE de Vercel → un PDF de 20 MB no sale por proxy. Entonces: **redirect 302 a URL firmada de R2 generada en el momento con TTL corto (5-10 min)** y `response-content-disposition`/`response-content-type` firmados en la query. Se firma recién al click (no en el listado), así no hace falta el TTL de 1 h que justificó ai-api por el poll del inbox.
- **URL PUT**: TTL 5-10 min, content-length y content-type firmados, una key por comprobante.
- **Rate limit** de `POST /api/portal/comprobantes`: Map por proceso clave `${tenant}:${codigocliente}` (ej. 10/hora) + tope diario en DB (COUNT por cliente en 24 h) porque el Map no se comparte entre instancias. El costo real de abuso es storage + mails a la empresa.
- **Contenido**: sniff obligatorio; nada de SVG/HTML; PDFs no se renderizan server-side (sin parsers en el server = sin superficie); EXIF stripeado en imágenes.
- **Inyección en mail**: escapar razón social/notas; el subject sin CR/LF.
- **Operator vs admin**: decidir quién ve la sección (datos financieros del cliente).

### Approaches

1. **Presigned PUT directo a R2 + confirm server-side (recomendada)** — lo de arriba.
   - Pros: único que funciona con 20 MB en Vercel; la función nunca recibe el archivo; esquiva el truncado del proxy; control total post-subida (sniff, conversión, key final).
   - Cons: CORS del bucket; flujo de 3 pasos en el cliente; filas/objetos huérfanos (`uploading` + lifecycle `tmp/`); la función igual baja el archivo para sniff/convertir/adjuntar.
   - Effort: Medium.
2. **Multipart a Route Handler** (`request.formData()` o stream con contador de bytes).
   - Pros: simple, un solo request, patrón ya usado en `catalog/upload`.
   - Cons: **roto en Vercel arriba de 4,5 MB** (413) y truncado silencioso del proxy arriba de 10 MB; obligaría a bajar el máximo a ~4 MB (fotos de celular y PDFs escaneados lo pasan seguido). Contradice la decisión de 20 MB.
   - Effort: Low — pero no cumple el requisito.
3. **Subida en chunks < 4,5 MB a la función → R2 multipart upload**.
   - Pros: no necesita CORS; la función ve todos los bytes.
   - Cons: multipart de S3 exige partes ≥ 5 MB salvo la última (choca con el tope de 4,5 MB → hay que acumular), estado entre requests, mucho más código. 
   - Effort: High.
4. **Compresión en el cliente + multipart chico** (canvas/wasm).
   - Pros: sin CORS ni presign.
   - Cons: no sirve para PDFs; HEIC en el browser = wasm pesado; confía en el cliente.
   - Effort: Medium. Descartada salvo como complemento (resize de imágenes antes del PUT para ahorrar datos móviles).

Subdecisión archivo en admin: **redirect a firmada corta** (recomendada, único que sirve > 4,5 MB) vs proxy (solo archivos chicos) vs URL firmada en el listado (TTL largo, queda en historial).

### Recommendation

Opción 1. Orden de entrega sugerido:
- A. Infra: `0023` (aplicada en prod antes del merge), `src/lib/r2.ts`, CORS + lifecycle del bucket, **key R2 re-scopeada a `crm-portal`** (y env en Vercel).
- B. Portal: modal "Informar pago" en `PagosTable` + rutas init/confirm (sin HEIC primero: rechazar HEIC con mensaje claro, apoyarse en el `accept` que hace convertir a iOS).
- C. Mail con adjunto/umbral + estado de envío.
- D. Admin "Comprobantes recibidos" (lista, ver archivo, marcar/deshacer cargado, reenviar mail) + campo "Email para comprobantes" en Configuración.
- E. HEIC→JPG server-side tras medirlo en preview.
Setear `receipts_email` de Avantec por UPDATE en prod o desde la pantalla (no en el código ni en la migración: repo público).

### Risks

1. **Límite 4,5 MB de Vercel** (request Y response) — invalida el multipart y el proxy de archivos grandes; el dato de 100 MB del brief está mal. Pasa en local y rompe en prod: probar en un preview con un archivo de 15-20 MB.
2. **Truncado silencioso del proxy a 10 MB** (`proxyClientMaxBodySize`) para cualquier body grande que pase por `/api/*`.
3. **Key R2 con acceso a todos los buckets** (lista `crm-adjuntos`, media de WhatsApp de todos los clientes). Re-scopear a `crm-portal` (Object Read & Write) antes de prod; el mismo secreto firma URLs que viajan al navegador (la firma no expone la secret, pero una fuga de env daría todo). Además limpiar `R2_TOKEN` del `.env` si no se usa.
4. **CORS del bucket** mal configurado (`*`) — restringir a los orígenes del portal; como es multi-tenant con dominios distintos, la lista crece por tenant (alta de tenant = tocar CORS). Alternativa: wildcard de subdominio `https://*.tevro.com.ar` + dominios propios.
5. **HEIC en Fluid**: memoria/CPU por concurrencia; bombas de descompresión; `heic-convert` sin mantenimiento desde 2023; `libheif-js` suma ~9 MB al bundle de la función.
6. **Tope de tamaño del buzón destino (Hotmail)** — adjunto aceptado por Resend pero rebotado por Outlook.com; mitigado con umbral + link.
7. **Huérfanos**: filas `uploading` y objetos `tmp/` si el cliente cierra la pestaña; lifecycle + limpieza.
8. **Migración antes que el merge**: `tenants.receipts_email` entra en `select()` de `getTenantByIdFromDb` → si el código llega antes que la columna **se cae todo el portal y el admin de todos los tenants** (no solo la feature). Aplicar 0023 en prod antes de mergear.
9. **Rutas admin sin guard**: el resto de `/api/admin/**` confía en la cookie; si se copia ese patrón, un cambio de rol/tenant no se refleja. Usar `getGuardedAdminSession`.
10. **Datos sensibles en repo público**: el mail destino real del tenant y el from no van en código, migración, tests ni PR.
11. **Rate limit por proceso** no es global entre instancias (ya aceptado en send-code); complementar con tope en DB.
12. **Duplicados**: el cliente puede informar el mismo pago dos veces → `file_sha256` para avisar "ya enviaste este archivo" (no bloquear).

### Preguntas abiertas

1. ¿Quién ve "Comprobantes recibidos": operator también, o admin+? ¿Quién puede marcar "cargado en Alegra" y deshacerlo?
2. ¿El destino de mail lo edita un admin del tenant desde Configuración, o solo superadmin? ¿Uno o varios destinatarios (coma-separados)?
3. ¿El from `comprobantes@example.com` es de plataforma para todos los tenants (env) o configurable por tenant?
4. ¿Umbral de adjunto (propuesto 10 MB) aceptado, o siempre adjuntar hasta 20 MB?
5. ¿Retención del archivo final (para siempre / N años)? ¿Borrado cuando se marca cargado? (recomendado: no borrar).
6. ¿El cliente ve en el portal los comprobantes que ya informó y su estado (pendiente/cargado)? Evita duplicados.
7. ¿Moneda siempre ARS o también USD? ¿Campo de notas/nro de operación opcional?
8. ¿Un archivo por comprobante o varios (ej. frente y dorso de cheque)? El modelo propuesto es 1.
9. ¿OK pedir CORS en `crm-portal` para los dominios del portal (y cómo manejar dominios propios de tenants)?
10. ¿Se hace resize de imágenes (2560 px) o se conserva el original además del JPG para auditoría?

### Ready for Proposal

**Sí, con una corrección previa al usuario**: el requisito de 20 MB es compatible con Vercel solo subiendo directo a R2 (presigned PUT), porque las funciones aceptan 4,5 MB y no 100 MB. Confirmar ese enfoque + CORS del bucket, y cerrar preguntas 1, 2, 3 y 6, que cambian rutas y modelo. HEIC puede ir como entrega aparte tras medirlo en preview.