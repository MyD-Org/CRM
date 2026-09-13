# Proposal: comprobantes-de-pago

Base: `main` (451fb77). Dependencia: `sdd/comprobantes-de-pago/explore` (engram #218). Límite de Vercel verificado por el orquestador después del explore (ver Intent).

## Intent

Hoy el cliente no tiene forma de avisar desde el portal que pagó: el botón viejo `AdjuntarModal` era un fake (`alert("Envío: próximamente")`) y se borró en 451fb77. El comprobante llega por WhatsApp/mail suelto, sin monto ni fecha estructurados, y nadie sabe cuáles ya se cargaron en Alegra ni si el cliente lo mandó dos veces.

Este cambio agrega el circuito completo **cliente informa → empresa recibe → alguien lo carga en Alegra a mano → queda registrado**:
- El cliente, desde **Pagos** en el portal, sube el comprobante (hasta **20 MB**) con **monto, fecha del pago y medio de pago**, y ve los que ya informó con su estado.
- La empresa recibe un **mail** (desde el remitente de plataforma) y tiene una pantalla admin **"Comprobantes recibidos"** para verlos y marcarlos "cargado en Alegra".

**Restricción de plataforma que define la arquitectura** (verificado, https://vercel.com/docs/functions/limitations, last_updated 2026-08-24): las Vercel Functions aceptan **4,5 MB de body, tanto request como response** (413 `FUNCTION_PAYLOAD_TOO_LARGE`); el "100 MB" del changelog devuelve 404. Además `src/proxy.ts` matchea `/api/*` y el proxy de Next 16 **trunca en silencio** bodies > 10 MB (`proxyClientMaxBodySize`). Con 20 MB de máximo, un multipart a un Route Handler **anda en local y rompe en prod**. ⇒ el archivo va **del navegador directo a R2 con URL PUT prefirmada**, y la función solo firma, confirma y procesa leyendo desde R2.

## Decisiones de producto que enmarcan el cambio (dadas, no se re-evalúan)

1. El cliente informa: archivo + **monto** + **fecha del pago** + **medio** (`transferencia | cheque | efectivo | otro`). **Sin selección de facturas.**
2. Entrega = **mail a la empresa + pantalla admin**. No se escribe en Alegra; un humano carga el pago.
3. **Solo `admin` y `superadmin`** ven la sección y marcan "cargado". `operator` no la ve (nav oculta) y las rutas le responden como si no existieran. Roles: `src/lib/roles.ts`.
4. **Un único mail destino por tenant**, editable desde Configuración (admin+).
5. **Remitente de plataforma para todos los tenants**: una casilla del dominio verificado en Resend (valor real solo en la env `RECEIPTS_EMAIL_FROM`, nunca en el repo), display name con el nombre del tenant (`"{Tenant} · Comprobantes"`), subject con prefijo fijo `[Comprobante de pago]`, `replyTo` = mail del cliente si existe.
6. **El cliente ve en Pagos los comprobantes que ya informó** con estado (pendiente / cargado), para evitar duplicados.
7. **HEIC → JPG en el servidor** durante el confirm (`heic-decode` + encode con `sharp`, con tope de píxeles). El `<input accept>` lista JPG/PNG/PDF para que iOS convierta solo la mayoría de las fotos. Se mantiene en este cambio, con riesgo explícito (medir en preview antes de mergear).
8. **Máximo 20 MB.** Se adjunta al mail hasta **10 MB**; más grande → mail con aviso y link al admin. Si el mail falla, el comprobante existe igual como pendiente con `email_status='failed'` y acción admin **"Reenviar"**.

Defaults que toma esta propuesta para las preguntas abiertas del explore no decididas (confirmar en spec si alguien objeta): moneda **solo ARS**; campo **notas opcional** (acotado, ej. nro de operación); **un archivo por comprobante**; **el archivo final no se borra** al marcar cargado (respaldo contable); `operator` recibe **404** (mismo criterio que `configuracion/page.tsx` → `notFound()`, no confirma existencia).

## Scope

### In Scope

1. **Storage R2 en el CRM** — `src/lib/r2.ts` (port de `ai-api/src/storage/r2.ts` con `aws4fetch`)
   - `r2Config()` "las 4 o ninguna" (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`); sin config → la feature responde 503 claro, no crashea el portal.
   - `signedPutUrl(key, contentType, contentLength, ttl)` firmando `content-type` y `content-length`; `signedGetUrl(key, ttl, {disposition, contentType})`; `headObject`, `getObject`, `putObject`, `deleteObject`.
   - Keys: `tmp/receipts/{tenantId}/{receiptId}` (destino del PUT, lifecycle 1 día) y `receipts/{tenantId}/{yyyy-mm}/{receiptId}.{ext}` (final, sin expiración). **Nunca** nombre original ni `codigocliente` en la key.

2. **Migración `0023` escrita a mano** — `drizzle/0023_payment_receipts.sql` + `drizzle/meta/_journal.json` (idx 23) + `src/db/schema.ts`
   - Estilo 0022: comentario "APLICAR EN PROD ANTES DE MERGEAR", `IF NOT EXISTS`, append-only. **Una sola migración para todo el cambio** aunque se entregue en varios PRs (un solo `db:migrate` manual contra prod).
   - Ver "Modelo de datos".

3. **Portal: informar pago** — `src/components/portal/DashboardClient.tsx` + rutas nuevas
   - Botón **"Informar pago"** en el slot `extraActions` del `Toolbar` de `PagosTable` (el slot ya existe con ese comentario) + modal nuevo con `FileDropZone`, `Field`, `Input`, `Select`, `DateRangeField`/fecha simple de `@myd-org/ui`. No se resucita el modal viejo (pedía facturas). `accept="image/jpeg,image/png,application/pdf"`.
   - `POST /api/portal/comprobantes` (JSON chico): sesión portal (`isLoggedIn && codigocliente`) → rate limit → valida metadatos y `fileSize` (0 < x ≤ 20 MB), `contentType` declarado ∈ {pdf, jpeg, png, webp, heic, heif} → crea fila `uploading` → devuelve `{ id, uploadUrl, headers }` (TTL 5–10 min).
   - Navegador → `PUT` directo a R2 (XHR para barra de progreso).
   - `POST /api/portal/comprobantes/[id]/confirm`: fila `(tenant, codigocliente, id, status='uploading')` → `HEAD` (tamaño real ≤ 20 MB, si no borra + 413) → `GET` → **sniff por magic bytes** (PDF/JPEG/PNG/WebP/HEIC; todo lo demás, SVG/HTML incluidos, → borrar tmp + 415) → conversión si HEIC → `PUT` a key final → `DELETE` tmp → `status='pending'`, `submitted_at`, `file_sha256` → mail. **Idempotente**: si ya está `pending`, OK sin re-mandar mail. `maxDuration = 60`, runtime Node.
   - Respuesta al cliente = éxito aunque falle el mail (el dato está a salvo). Si el `sha256` coincide con otro comprobante del mismo cliente, se avisa "ya enviaste este archivo" (no bloquea).
   - Rate limit: Map por proceso con clave `${tenant}:${codigocliente}` (patrón `send-code`) **+ tope diario en DB** (COUNT 24 h), porque el Map no se comparte entre instancias.

4. **Portal: historial de comprobantes informados** (decisión 6)
   - `GET /api/portal/comprobantes` filtrando `tenant_id` + `codigocliente` de la sesión, excluye `uploading`, `Cache-Control: private, no-store`.
   - Listado en el área Pagos: fecha informada, fecha del pago, monto, medio, estado (Pendiente / Cargado). Sin acceso al archivo desde el portal en v1 (el cliente ya lo tiene).

5. **Mail a la empresa** — `src/lib/receipt-email.ts` (builder puro, patrón `otp-email.ts`) + `src/lib/email.ts`
   - `sendEmail` gana un objeto opcional al final `{ attachments?, from?, replyTo?, tags? }` sin romper la firma actual (el resto de los mails siguen saliendo con `tenant.resendFrom`).
   - From: env `RECEIPTS_EMAIL_FROM` (la dirección de plataforma) con display name `"{tenant.name} · Comprobantes"`; **no hardcodeada en código** (repo público). `to = tenant.receiptsEmail`; `replyTo = session.email` si hay; subject `[Comprobante de pago] {razonsocial} — ${monto} — {dd/mm/aaaa}` sin CR/LF; `tags` `type=payment_receipt`, `tenant`.
   - Cuerpo con todo lo del cliente **escapado** + link relativo al host del tenant `/admin/comprobantes?id=…` (no URL firmada: vencería en el buzón).
   - Adjunto si el archivo final ≤ 10 MB; si no, aviso "pesa X MB, verlo en el backoffice".
   - `email_status`: `sent` | `failed` (+ `email_error`) | `skipped` (sin `RESEND_API_KEY` o `receiptsEmail` vacío).

6. **Admin: "Comprobantes recibidos"** — `src/app/admin/(protected)/comprobantes/page.tsx` + componente cliente + rutas
   - Nav en `src/components/admin/AdminShell.tsx` (`minRole: "admin"`, icono `Receipt`); la página hace `notFound()` para operator.
   - Tabla con filtro pendiente / cargado, badge "mail no enviado", acciones **Ver archivo**, **Marcar cargado en Alegra** / **Deshacer**, **Reenviar mail**.
   - `GET /api/admin/comprobantes` (lista paginada), `PATCH /api/admin/comprobantes/[id]` (`pending ↔ loaded`, graba `loaded_at`, `loaded_by`, `loaded_by_name`), `GET /api/admin/comprobantes/[id]/file` (**302 a URL firmada de R2 generada al click**, TTL 5–10 min, con `response-content-disposition` = `comprobante-{fecha}-{id8}.{ext}` y `response-content-type` = mime sniffeado; no proxy de bytes por el límite de 4,5 MB de response), `POST /api/admin/comprobantes/[id]/resend-email`.
   - **Todas las rutas nuevas usan `getGuardedAdminSession(req)`** (tenant del host + rol fresco de la DB), exigen `roleRank ≥ 1` (si no, 404) y filtran `WHERE tenant_id = <tenant del guard> AND id = …`. No se copia el patrón de cookie cruda del resto de `/api/admin/**`.

7. **Configuración: mail destino** — `src/app/api/admin/settings/receipts/route.ts` (GET/PUT, guard + admin+) + tab nuevo "Comprobantes" en `ConfiguracionShell.tsx` / `configuracion/page.tsx`
   - Un solo email, validado; vacío permitido (queda `skipped` con aviso visible en la pantalla de comprobantes).
   - `src/lib/tenants.ts`: `TenantConfig.receiptsEmail` en `getTenantByIdFromDb` y `""` en el fallback por env.

8. **HEIC → JPG + higiene de imágenes** — `src/lib/receipt-file.ts` (puro, unit-testeable)
   - Sniff de magic bytes, saneo de nombre original (NFKD, sin control/separadores, `[\w.-]`, ≤ 80 chars, extensión re-derivada del mime real).
   - HEIC/HEIF: leer dimensiones y **rechazar > 50 MP antes de decodificar** → `heic-decode` → `sharp(raw).resize({width:2560, withoutEnlargement:true}).jpeg({quality:82, mozjpeg:true})`; `converted_from='image/heic'`.
   - JPEG/PNG: `sharp().rotate()` para **strip de EXIF** (GPS del celular). PDF tal cual, sin parsear server-side.

9. **Tests** (vitest: `npm test` unit, `npm run test:integration` contra `crm_test`)
   - Unit: magic bytes (incl. SVG/HTML disfrazado de `image/png` → rechazo), saneo de nombres, builder del mail (escape, subject sin CRLF, umbral de adjunto), firma de `r2.ts` con `fetch` mockeado, validación de metadatos.
   - Integración: aislamiento admin (admin de A no lista / abre / marca / reenvía comprobantes de B → 404); **operator → 404** en todas las rutas admin nuevas; portal: cliente X no confirma ni lista comprobantes de cliente Y; confirm idempotente; fallo de mail deja `pending` + `failed`.
   - Fixtures genéricos: **nada de datos reales de clientes ni el mail destino de Avantec** (repo público).

10. **Docs** — `docs/FUNCIONALIDADES.md` (feature nueva) y `docs/DEPLOY.md` (envs R2, `RECEIPTS_EMAIL_FROM`, CORS + lifecycle del bucket, orden migración→merge).

### Out of Scope

- **Proxy del visor de PDFs del portal** — `src/app/api/portal/documentos/[kind]/[id]/route.ts` (PR #108) pasa los bytes del PDF de Alegra por la función: cualquier documento > 4,5 MB daría 413. Hoy las facturas pesan ~80 KB y no muerde. **Follow-up aparte**, mismo arreglo: redirect a URL firmada.
- **Migrar las 36 rutas existentes de `/api/admin/**` a `getGuardedAdminSession()`** — ya hay una tarea separada. Acá solo las rutas nuevas nacen con el guard.
- Escribir el pago en Alegra / conciliación automática / asociar a facturas.
- Varios destinatarios, remitente por tenant, varios archivos por comprobante, monedas distintas de ARS.
- Que el cliente vea o descargue el archivo desde el portal; que el cliente edite o borre un comprobante informado.
- Historial completo de eventos (tabla de auditoría): con `loaded_by/at` alcanza para v1.
- Política de retención/borrado del archivo final.
- Conversión HEIC en el navegador (`heic2any`).
- Limpieza de `R2_TOKEN` del `.env` local (ruido, no lo usa nadie; se anota, no se toca).

## Approach

**Presigned PUT directo a R2 + confirm server-side** (opción 1 del explore; las demás no cumplen 20 MB en Vercel o son mucho más caras):

1. **Init** — `POST /api/portal/comprobantes` con metadatos (sin archivo). Sesión portal → rate limit → validación → fila `uploading` → URL PUT prefirmada que firma `content-type` y `content-length` (R2 no soporta POST policy con `content-length-range`, así que el tope va en la firma y se re-verifica en el confirm). La key la decide el server.
2. **Upload** — el navegador hace `PUT` a R2. Requiere **CORS** en `crm-portal` restringido a los orígenes del portal (`PUT`, header `content-type`). El archivo nunca toca una función ni el proxy.
3. **Confirm** — `POST …/[id]/confirm`: `HEAD` + `GET` desde R2 (bajar 20 MB desde la función no está limitado; lo limitado es el body de la invocación), sniff, conversión/strip, key final, borrar tmp, `pending`. El mime guardado es **siempre el sniffeado**, nunca el declarado.
4. **Mail** — se manda **antes de responder** (Vercel puede congelar la función después de la respuesta); su fallo no revierte nada, queda `email_status='failed'` y el admin puede reenviar.
5. **Admin** — lista y marca con el guard de tenant+rol en DB; el archivo se sirve con 302 a URL firmada corta generada al click.
6. **Huérfanos** — filas `uploading` > 1 día se limpian (lazy en el init o cron existente) y los objetos `tmp/` los borra la lifecycle rule del bucket.

Aislamiento en todas las capas: portal `WHERE tenant_id AND codigocliente = session.codigocliente`; admin `WHERE tenant_id = guard.tenantId AND id`; la key incluye `tenantId` y siempre se toma de la fila, nunca del request; lo ajeno responde 404.

## Modelo de datos (resumen de `0023_payment_receipts.sql`)

- `tenants.receipts_email text NOT NULL DEFAULT ''` — **entra en el `select()` explícito de `getTenantByIdFromDb`**: por eso la migración va en prod antes del merge.
- Tabla nueva `payment_receipts`:
  - Identidad y aislamiento: `id uuid PK`, `tenant_id → tenants`, `codigocliente` (de la sesión, nunca del body).
  - Snapshot del cliente: `razonsocial`, `cuit`.
  - Pago: `amount numeric(14,2) > 0`, `currency DEFAULT 'ARS'`, `paid_on date` (no futura), `method` CHECK (`transferencia|cheque|efectivo|otro`), `method_other`, `notes`.
  - Estado: `status` CHECK (`uploading|pending|loaded`), `created_at`, `submitted_at`.
  - Archivo: `file_key`, `file_mime` (sniffeado/convertido), `file_size`, `file_original_name` (saneado, informativo), `file_sha256`, `converted_from`.
  - Mail: `email_status` CHECK (`pending|sent|failed|skipped`), `email_error`, `email_sent_at`.
  - Auditoría de carga: `loaded_at`, `loaded_by → admin_users ON DELETE SET NULL`, `loaded_by_name` (snapshot).
- Índices: `(tenant_id, status, created_at)` para el admin y `(tenant_id, codigocliente, created_at)` para el portal y el dedup/rate limit.
- El mail destino real de cada tenant se carga **desde Configuración o por UPDATE en prod**, nunca en la migración.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `drizzle/0023_payment_receipts.sql`, `drizzle/meta/_journal.json` | New | Columna en `tenants` + tabla `payment_receipts` |
| `src/db/schema.ts` | Modified | `paymentReceipts`, `tenants.receiptsEmail` |
| `src/lib/tenants.ts` | Modified | `TenantConfig.receiptsEmail` (DB + fallback env) |
| `src/lib/r2.ts` | New | Cliente R2 con `aws4fetch` (presign PUT/GET, head/get/put/delete) |
| `src/lib/receipt-file.ts` | New | Magic bytes, saneo de nombre, HEIC→JPG, strip EXIF |
| `src/lib/receipt-email.ts` | New | Builder `{subject, html, text}` escapado |
| `src/lib/email.ts` | Modified | Opciones `attachments/from/replyTo/tags` compatibles hacia atrás |
| `src/app/api/portal/comprobantes/route.ts` | New | `POST` init + `GET` historial del cliente |
| `src/app/api/portal/comprobantes/[id]/confirm/route.ts` | New | Confirm: verificación, conversión, key final, mail |
| `src/components/portal/DashboardClient.tsx` (+ componente del modal/historial) | Modified/New | Botón "Informar pago", modal, listado con estado |
| `src/app/admin/(protected)/comprobantes/page.tsx` + componente cliente | New | "Comprobantes recibidos" (admin+) |
| `src/app/api/admin/comprobantes/route.ts`, `[id]/route.ts`, `[id]/file/route.ts`, `[id]/resend-email/route.ts` | New | Lista, marcar/deshacer, 302 a firmada, reenviar; todas con `getGuardedAdminSession` |
| `src/app/api/admin/settings/receipts/route.ts` | New | GET/PUT del mail destino |
| `src/components/admin/AdminShell.tsx` | Modified | Entrada "Comprobantes" con `minRole: "admin"` |
| `src/components/admin/ConfiguracionShell.tsx`, `src/app/admin/(protected)/configuracion/page.tsx` | Modified | Tab "Comprobantes" con el mail destino |
| `package.json`, `package-lock.json` | Modified | `aws4fetch`, `heic-decode`, `sharp` directo |
| `test/unit/**`, `test/integration/**` | New | Ver Scope 9 |
| `docs/FUNCIONALIDADES.md`, `docs/DEPLOY.md` | Modified | Feature + operación |
| Bucket `crm-portal` (Cloudflare) | Config | CORS para PUT desde el portal + lifecycle `tmp/` a 1 día |
| Token R2 (Cloudflare) | Config | Re-scopear a `crm-portal` (Object Read & Write) |
| Vercel (Production/Preview env) | Config | `R2_*`, `RECEIPTS_EMAIL_FROM` + redeploy |
| `src/app/api/portal/documentos/[kind]/[id]/route.ts` | **Sin cambios** | Bug latente de 4,5 MB → follow-up |

## Dependencies

- **npm nuevas (registro público npmjs)**: `aws4fetch` (el mismo que usa ai-api), `heic-decode` (→ `libheif-js`, ~9 MB desempaquetado, wasm), `sharp` como dependencia **directa** (hoy 0.34.5 transitiva de `next`; fijar la misma minor para no duplicar binarios).
  - **GitHub Packages / CI**: el `.npmrc` solo redirige el scope `@myd-org` a `npm.pkg.github.com`, así que estas tres bajan de npmjs sin tocar el token. No agregan dependencia nueva del `GITHUB_TOKEN` (el riesgo de PAT vencido en Vercel sigue siendo el que ya existe por `@myd-org/ui`).
  - `sharp` usa binarios por plataforma como `optionalDependencies` (`@img/sharp-linux-x64` etc.): el `package-lock.json` tiene que incluir la variante linux (CI en `ubuntu-latest` y Vercel). Regenerar el lock con `npm install` normal, **nunca** `--omit=optional` ni `--no-optional`. Verificar que `libheif-js`/`sharp` quedan dentro del output tracing de la función de confirm (si no, `serverExternalPackages`), y que el bundle de la función no se pasa del límite de Vercel.
- **Cloudflare**: acceso para CORS, lifecycle y un token nuevo scopeado a `crm-portal`.
- **Resend**: `tevro.com.ar` ya verificado; `RESEND_API_KEY` ya existe.
- **Vercel**: acceso al proyecto para envs y redeploy; un **preview** para las pruebas de tamaño y HEIC.
- DB local `crm_test` (ya existe). No depende de la migración de las rutas admin viejas ni del follow-up de documentos.

## Checklist pre-producción (bloqueante)

- [ ] **Aplicar `0023` en prod ANTES de mergear** (`db:migrate` a mano; los deploys de Vercel no migran). `getTenantByIdFromDb` selecciona columnas de `tenants` por nombre: si el código llega antes que `receipts_email`, **se cae portal y admin de todos los tenants**, no solo esta feature. Verificar hash en `__drizzle_migrations`.
- [ ] **Re-scopear la key de R2** a solo `crm-portal` (hoy puede listar `crm-adjuntos` = media de WhatsApp de todos los clientes) y cargar la nueva en Vercel. No reusar la actual.
- [ ] **CORS en `crm-portal`**: `PUT` (y `GET` si hiciera falta) solo desde los orígenes del portal (`https://*.tevro.com.ar` + dominios propios de tenants), header `content-type`; **nunca `*`**.
- [ ] **Lifecycle** en `crm-portal` para el prefijo `tmp/` (1 día).
- [ ] **Mail destino configurado** para el tenant (Avantec) desde Configuración o UPDATE en prod — fuera del repo.
- [ ] **Env vars en Vercel** (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RECEIPTS_EMAIL_FROM`) en Production y Preview **+ redeploy** (las envs no aplican en caliente).
- [ ] **Prueba en un preview de Vercel** con un PDF de **15–20 MB**: sube, confirma, llega el mail sin adjunto con link, el admin abre el archivo (302). Y uno < 10 MB con adjunto.
- [ ] **HEIC medido en preview**: 3–4 HEIC reales de iPhone (12 y 48 MP), tiempo y memoria pico del confirm, y 2–3 concurrentes (Fluid comparte instancia). Si no entra cómodo en `maxDuration` y memoria, se mergea sin HEIC (rechazo con mensaje claro) y HEIC queda para después.
- [ ] Revisar que PR, tests y fixtures **no contienen el mail de Avantec, URLs de prod ni datos reales** (repo público).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Algo del archivo pasa por una función o por el proxy (multipart, proxy de bytes) → 413 > 4,5 MB o truncado silencioso > 10 MB. Anda en local, rompe en prod | Alta si se desvía del diseño | PUT directo a R2 y 302 a firmada; prueba obligatoria con 15–20 MB en preview |
| Código mergeado antes que `0023` tira portal y admin de **todos** los tenants | Media | Checklist: migración en prod antes del merge; nota en el PR y en el `.sql` |
| Key R2 actual con acceso a todos los buckets (media de WhatsApp) | Alta hoy | Re-scopear antes de prod; es bloqueante |
| CORS mal configurado (`*`) o incompleto (dominio propio de un tenant no listado → subida falla solo ahí) | Media | Lista explícita + wildcard de subdominio; alta de tenant con dominio propio = actualizar CORS (documentado en DEPLOY) |
| HEIC en Fluid: CPU/memoria por concurrencia, bomba de descompresión, `heic-decode`/`libheif-js` poco mantenido, +~9 MB al bundle | Media | Tope 50 MP antes de decodificar, resize a 2560 px, medición en preview; PR separado que se puede no mergear |
| Binarios de `sharp` faltantes en Vercel/CI por lockfile generado sin optional deps | Baja | `npm install` normal; CI (`npm ci` en ubuntu) lo detecta; verificar output tracing |
| Resend acepta el adjunto pero el buzón destino (Hotmail/Outlook) lo rebota por tamaño | Media | Umbral 10 MB → link al admin; `email_status` + Reenviar |
| Fallo de mail deja a la empresa sin enterarse | Media | El comprobante queda `pending` visible en admin con badge; `skipped` si falta destino, con aviso |
| Rutas nuevas copiando el patrón de cookie cruda (rol viejo, operator ve datos financieros) | Media | Todas con `getGuardedAdminSession` + `roleRank ≥ 1`; test de integración operator → 404 |
| Huérfanos: filas `uploading` y objetos `tmp/` si el cliente cierra la pestaña | Alta (bajo impacto) | Lifecycle 1 día + limpieza de filas viejas; `uploading` nunca se muestra |
| Abuso: spam de subidas → storage + mails a la empresa | Baja | Rate limit por proceso + tope diario en DB; tamaño firmado en la URL y re-verificado |
| Archivo malicioso (SVG/HTML como imagen, PDF raro) | Baja | Sniff obligatorio, allowlist, mime sniffeado + `Content-Disposition` controlado, sin parseo de PDF server-side |
| Inyección en el mail (razón social/notas) o header injection en el subject | Baja | Escape HTML y subject sin CR/LF, con unit tests |
| Duplicados del mismo pago | Media | Historial visible en el portal (decisión 6) + aviso por `file_sha256` |
| Datos sensibles en repo público | Media | Destino y from fuera del código (DB / env); revisión en el checklist |

## Rollback Plan

1. **Código**: `git revert` del/los merge commits y redeploy (o Instant Rollback en Vercel). Las rutas, la nav y el botón desaparecen; nada del resto del portal/admin depende de ellos.
2. **DB: NO revertir `0023`.** Es aditiva (columna con default + tabla nueva); el código viejo no la lee y convive sin problema. Dropear la columna con código nuevo desplegado tiraría todo (mismo motivo del checklist). Los comprobantes ya informados quedan en la tabla y se pueden recuperar si se vuelve a desplegar.
3. **R2**: los objetos en `receipts/` se conservan (son respaldo contable); `tmp/` se limpia solo por lifecycle. CORS y token re-scopeado pueden quedar: no afectan a nada más.
4. **Rollback parcial**: por la división en PRs, se puede revertir solo HEIC (C) o solo el historial del portal (B) sin tocar el flujo principal. Para apagar la feature sin revert, quitar `R2_*` del entorno + redeploy → las rutas responden 503 y el botón se oculta.
5. **Mail**: si hay un problema con el remitente, vaciar `RECEIPTS_EMAIL_FROM` o `receipts_email` → `email_status='skipped'`; los comprobantes siguen llegando al admin.

## Entrega sugerida (un cambio, 3 PRs)

- **A — Flujo principal (storage + subida + mail + admin + configuración)**: `0023` completa, `r2.ts`, `receipt-file.ts` sin HEIC (HEIC declarado/sniffeado → 415 con mensaje "convertí a JPG o PDF"; el `accept` hace que iOS convierta solo), init/confirm, modal del portal, mail con umbral, pantalla admin con marcar/deshacer/reenviar, tab de Configuración, tests de aislamiento y roles.
  *Por qué junto*: es el mínimo que entrega valor. Subir sin que nadie se entere (sin mail ni admin) es peor que no tener botón; y el admin sin subida no tiene qué mostrar. Es grande, pero cada pieza es chica y se prueba de punta a punta en un preview.
- **B — Historial en el portal**: `GET /api/portal/comprobantes` + listado con estado en Pagos + aviso de duplicado por sha256.
  *Por qué aparte*: solo lectura, sin schema nuevo (la tabla ya vino en A), riesgo bajo; se revisa como UI pura.
- **C — HEIC → JPG + strip de EXIF/resize**: `heic-decode`, `sharp` directo, tope de píxeles, medición en preview.
  *Por qué aparte*: es la única parte con riesgo de runtime incierto (memoria/CPU en Fluid, bundle +9 MB, deps nativas/wasm). Aislarla permite mergear A sin esperar la medición y descartar C si no entra, sin tocar el resto. (El strip de EXIF va acá porque también requiere `sharp` directo.)

`0023` va entera en A para hacer **un solo `db:migrate` manual** en prod.

## Success Criteria

- [ ] Un cliente logueado sube un PDF de **~18 MB** en un **preview de Vercel** y el flujo termina OK (sin 413 ni truncado); el archivo en R2 tiene exactamente el tamaño y el sha256 del original.
- [ ] Un archivo que dice `image/png` pero es SVG/HTML → 415, y no queda objeto en `receipts/` ni fila `pending`.
- [ ] Un PUT con tamaño distinto del firmado es rechazado por R2; un objeto > 20 MB en tmp es borrado en el confirm con 413.
- [ ] La empresa recibe el mail desde el remitente de plataforma con display name del tenant, subject `[Comprobante de pago] …`, `replyTo` = cliente; con adjunto si ≤ 10 MB, con aviso + link si > 10 MB.
- [ ] Con Resend fallando: el cliente ve éxito, el comprobante aparece `pending` con badge "mail no enviado", y "Reenviar" lo pasa a `sent`.
- [ ] Admin y superadmin ven "Comprobantes recibidos", abren el archivo (302 a firmada corta) y marcan/deshacen "cargado" quedando `loaded_by`/`loaded_at`.
- [ ] Un **operator** no ve la entrada en la nav y recibe **404** en la página y en todas las rutas `/api/admin/comprobantes/**` y `settings/receipts`.
- [ ] Admin del tenant A → 404 al listar, abrir, marcar o reenviar comprobantes del tenant B (test de integración).
- [ ] El cliente ve en Pagos sus comprobantes informados con estado Pendiente/Cargado, y nunca los de otro cliente.
- [ ] Un HEIC real de iPhone se convierte a JPG dentro de `maxDuration` y con memoria medida y aceptable en preview (o, si no, C no se mergea y A rechaza HEIC con mensaje claro).
- [ ] El mail destino se edita desde Configuración (admin+) y el vacío queda como `skipped` con aviso.
- [ ] `npm run lint`, `npm test` y `npm run test:integration` en verde en CI.
- [ ] Checklist pre-producción completo; `0023` aplicada en prod antes del merge; ni el mail de Avantec ni datos reales en el repo.