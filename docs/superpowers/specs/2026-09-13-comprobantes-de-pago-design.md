# Design: comprobantes-de-pago

Base: `origin/main` 23589f1 (#112, mismo contenido que 451fb77). Depende de `sdd/comprobantes-de-pago/proposal` (#220) y `explore` (#218). Escrito en paralelo con la spec (no leída): si la spec contradice algo de acá, manda la spec en *qué* y este doc en *cómo*; anotar la diferencia en tasks.

## Technical Approach

Invariante que ordena todo:

> **Ningún byte del archivo pasa por una Vercel Function ni por `src/proxy.ts`.** El navegador sube directo a R2 con una URL PUT prefirmada; la función solo firma, verifica leyendo desde R2 y publica. Para mirarlo, el admin recibe un 302 a una URL GET firmada corta. Límites que lo imponen: 4,5 MB de body (request y response) en Vercel, y truncado silencioso a 10 MB del proxy (`proxyClientMaxBodySize`).

Segundo invariante: **la fila de `payment_receipts` es una máquina de estados con transiciones atómicas por `UPDATE … WHERE status = … RETURNING`**. Eso da idempotencia y exclusión mutua sin locks explícitos ni transacciones largas (Neon + pooler, `prepare:false`): un confirm doble o concurrente no puede mandar dos mails ni publicar dos veces.

Tercer invariante: **tenant y cliente salen siempre del server** (tenant de `resolveRequestTenantId(req)`, `codigocliente` de la sesión; admin: `getGuardedAdminSession(req)`); la key de R2 sale siempre de la fila, nunca del request.

Tres PRs sobre un solo cambio (proposal): **A** flujo principal + TODA la migración 0023; **B** historial del cliente en el portal; **C** HEIC→JPG + strip EXIF. El diseño deja un único punto de extensión (`processReceiptFile`) para que C se pueda plegar en A agregando un archivo, sin reestructurar.

## Hallazgos verificados en esta fase (cambian detalles del proposal)

1. **aws4fetch NO firma `content-type` ni `content-length` por defecto.** `UNSIGNABLE_HEADERS` (aws4fetch 1.0.20, `dist/aws4fetch.esm.mjs` l.18) incluye ambos; solo entran con `allHeaders: true`. Un port literal de `ai-api/src/storage/r2.ts` generaría una URL PUT que acepta cualquier tipo y tamaño, sin error visible. `presignPut` usa `AwsV4Signer` con `signQuery: true, allHeaders: true`, y hay un unit test que assertea `X-Amz-SignedHeaders=content-length;content-type;host`.
2. **Qué honra R2 en un PUT prefirmado** (developers.cloudflare.com/r2/api/s3/presigned-urls/, last updated 2026-08-22): métodos GET/HEAD/PUT/DELETE; **POST (form policy con `content-length-range`) NO soportado**; `Content-Type` firmado → si el cliente manda otro, `403 SignatureDoesNotMatch` (documentado); expiración 1 s–7 días. **`Content-Length` firmado: NO documentado.** Por SigV4 debería dar 403 si el tamaño real difiere (el header entra al canonical request), pero no está garantizado por la doc ⇒ se firma igual (defensa gratis) y **la barrera autoritativa es el HEAD del confirm**. Se verifica empíricamente en el preview (criterio de éxito ya en el proposal). Si R2 no lo hiciera cumplir, lo peor es un objeto grande en `tmp/` por ≤1 día (lifecycle) — acotado además por rate limit.
3. **CORS de R2**: la doc oficial no documenta comodines de subdominio (`https://*.tevro.com.ar`) en `AllowedOrigins`; todos los ejemplos son orígenes completos. ⇒ **lista explícita de orígenes** (ver CORS). Y la doc confirma que presigned + navegador **requiere** CORS.
4. **`PagosTable` ya no renderiza `Toolbar`** desde #112 (se sacaron los filtros de pagos). El slot `extraActions` existe en `Toolbar`, pero Pagos no lo usa. Se vuelve a montar `<Toolbar hideFilter extraActions={…} />` en `PagosTable`; verificado en el código que sin `filterOptions`/`multiFilterOptions`/fechas el Toolbar solo pinta el slot (`hasDateFilter` falso, filtros condicionados).
5. **`usePaginado`, `Paginacion` y `useEsDesktop` son funciones internas de `DashboardClient.tsx`** (no exportadas). B las mueve tal cual a un módulo propio para reutilizarlas.
6. **La sesión del portal no tiene `tenantId`** (`SessionData` = codigocliente, razonsocial, cuit, email, tipoCuenta, isLoggedIn; `verify-code` no guarda tenant). Las rutas del portal toman el tenant del host. Ver Riesgos.
7. **Resend 6.12.4 soporta `idempotencyKey`** como 2º argumento de `emails.send` (header `Idempotency-Key`), además de `attachments {content: Buffer, filename, contentType}`, `replyTo`, `tags {name,value}` (solo `[A-Za-z0-9_-]`).
8. **`@myd-org/ui` no tiene date picker simple** (solo `DateRangeField`): fecha del pago con `<Input type="date">`. Sí hay `Progress` para la barra de subida, `Textarea` para notas.
9. **`sharp` está en la lista automática de `serverExternalPackages`** de Next (doc local `serverExternalPackages.md`); `heic-decode`/`libheif-js` no.
10. Next 16 local: `redirect()` de `next/navigation` en Route Handlers responde **307** y tiene que ir fuera de `try`; para el visor se usa `NextResponse.redirect(url, 302)`. `params` es `Promise`. `maxDuration` y `runtime` son route segment config (default `nodejs`). `after()` existe en Route Handlers y corre dentro del `maxDuration`.

## Architecture Decisions

### D1 — Presigned PUT directo a R2 + confirm server-side
**Choice**: init (JSON) → PUT navegador→R2 → confirm (JSON).
**Rejected**: multipart a Route Handler (413 > 4,5 MB en Vercel, truncado > 10 MB en proxy: anda en local, rompe en prod); chunks < 4,5 MB → multipart S3 (partes ≥ 5 MB salvo la última, estado entre requests, mucho código); compresión en cliente (no sirve para PDF).
**Rationale**: único que cumple 20 MB en Vercel. Ya decidido en proposal; se registra por completitud.

### D2 — El confirm publica los bytes que verificó (GET completo + PUT final), no CopyObject
**Choice**: HEAD → GET por rango (sniff barato) → GET completo con tope → re-sniff + sha256 sobre el buffer → PUT a la key final **desde ese buffer** → UPDATE → DELETE tmp.
**Rejected**:
- *CopyObject tmp→final*: ahorra re-subir 20 MB, pero abre un TOCTOU — la URL PUT sigue viva hasta 10 min y el cliente puede pisar `tmp/` entre el sniff y el copy, publicando bytes nunca verificados. Cerrarlo exige `x-amz-copy-source-if-match` con el ETag, cuyo soporte en R2 no verificamos. Además en C los bytes cambian (conversión) y habría dos caminos.
- *Solo GET por rango sin bajar el archivo*: no permite sha256 ni adjunto.
**Rationale**: lo publicado es por construcción exactamente lo sniffeado y hasheado, y A y C comparten camino (C solo cambia el buffer). 20 MB en memoria es aceptable (Fluid, 2 GB). El GET por rango previo evita bajar 20 MB de basura.

### D3 — Máquina de estados con leases por UPDATE condicional; estados `processing` y `rejected` nuevos
**Choice**: `status ∈ {uploading, processing, pending, loaded, rejected}`. El confirm "toma" la fila con `UPDATE … SET status='processing', processing_started_at=now() WHERE id AND tenant AND codigocliente AND (status='uploading' OR (status='processing' AND processing_started_at < now() - interval '120 seconds')) RETURNING *`. Lease 120 s > `maxDuration` 60 s ⇒ un confirm muerto a mitad de camino se retoma, uno vivo nunca se pisa.
**Rejected**: `SELECT … FOR UPDATE` en transacción (mantiene conexión/lock durante segundos de I/O a R2 y Resend, mal con pooler); advisory locks (se atan a la sesión de conexión, frágil con `prepare:false` y pool); solo `uploading|pending|loaded` del proposal (no hay forma de distinguir "otro confirm está trabajando" de "nadie empezó", y el rechazo no deja rastro para el tope diario).
**Rationale**: atómico, sin locks, retomable. `rejected` (+`reject_reason`) cuenta para el tope diario anti-abuso y sirve de auditoría; nunca se muestra ni en admin ni en portal. **Desviación del proposal**, aditiva y dentro de 0023.

### D4 — Mail exactamente-una-vez con lease propio + `idempotencyKey` de Resend
**Choice**: un único camino `deliverReceiptEmail()` para el envío inicial y el "Reenviar". Toma un lease: `UPDATE … SET email_attempts = email_attempts + 1, email_last_attempt_at = now() WHERE id AND tenant_id AND status IN ('pending','loaded') AND (email_last_attempt_at IS NULL OR email_last_attempt_at < now() - interval '60 seconds') RETURNING email_attempts`. Sin fila ⇒ ya hay un envío en curso (409 en resend; no-op en confirm). Resend recibe `idempotencyKey = payment-receipt/{id}/{attempt}`.
**Rejected**: confiar solo en el estado `pending` del confirm (no cubre dos clicks de "Reenviar"); solo idempotencyKey (no cubre la ventana antes del POST a Resend ni reintentos después de la ventana de Resend).
**Rationale**: el lease impide dos envíos concurrentes; la key cubre el reintento HTTP del mismo intento. El confirm manda el mail **solo** en la llamada que hizo la transición a `pending`; una re-llamada que encuentra `pending` devuelve OK sin mandar.

### D5 — Mail antes de responder (no `after()`)
**Choice**: el confirm espera el envío (con el adjunto) y recién ahí responde; el resultado del mail no cambia la respuesta al cliente.
**Rejected**: `after()` — soportado en Route Handlers y corre dentro de `maxDuration`, respondería más rápido; se descarta en v1 para no depender de que la plataforma mantenga viva la invocación post-respuesta y porque el estado `email_status='pending'` + lease ya hacen recuperable cualquier corte. Queda como optimización si la latencia molesta (subir 13 MB base64 a Resend puede tardar segundos). Cambiarlo no toca el modelo.

### D6 — Visor admin: 302 a URL firmada corta; metadatos puestos en el PUT final
**Choice**: `GET /api/admin/comprobantes/[id]/file` → `NextResponse.redirect(signedUrl, 302)`, TTL 300 s, firmada al click. El PUT final guarda `Content-Type` = mime sniffeado y `Content-Disposition: inline; filename="comprobante-{paidOn}-{id8}.{ext}"`, así la vista inline no depende de overrides. Para descargar (`?download=1`) se firma `response-content-disposition=attachment; filename=…`.
**Rejected**: proxy de bytes (límite 4,5 MB de response); URL firmada en el listado (TTL largo, queda en historial — el motivo del TTL de 1 h de ai-api era el poll del inbox, que acá no existe).
**Rationale**: el contenido se sirve desde el origen de R2, no del CRM ⇒ un archivo raro no puede ejecutar nada en el origen del backoffice; y solo se guardan PDF/JPEG/PNG/WebP sniffeados. `Cache-Control: private, no-store` y `Referrer-Policy: no-referrer` en el 302.

### D7 — `src/lib/r2.ts` lanza errores tipados (no booleanos) y es inyectable
**Choice**: `createR2(cfg, deps?)` devuelve un cliente; errores `R2Error { op, status }`; `head`/`getRange`/`getObject` devuelven `null` en 404; `delete` es idempotente. `getR2()` memoiza con `r2Config()` y devuelve `null` si faltan envs.
**Rejected**: el `boolean` de ai-api (allá un fallo de storage no puede tumbar el webhook; acá el confirm necesita distinguir 404 de tmp, objeto grande y error de red para elegir 409/413/502).
**Rationale**: los routes mockean `@/lib/r2` con un fake en memoria; el propio `r2.ts` se testea con `fetch` inyectado.

### D8 — Rutas admin nuevas con un helper `requireAdminPlus(req)`; operator → 404
**Choice**: helper chico en `src/lib/admin-route-guard.ts` sobre `getGuardedAdminSession(req)`: guard falla → 401 `{error:"no autorizado"}` (reason solo a logs); `roleRank(user.role) < 1` → 404 `{error:"no encontrado"}`. Rol de la fila, nunca `session.role`. Página: `getGuardedAdminSession()` + `notFound()`.
**Rejected**: copiar el patrón de cookie cruda de `settings/schedule` (tenant/rol viejos de la cookie; 403 confirma existencia).
**Rationale**: 5 rutas nuevas con la misma política en un solo lugar; los tests de "operator → 404" se escriben una vez con `it.each`.

### D9 — Portal: tenant del host vía `resolveRequestTenantId(req)` + helper `requirePortalClient(req)`
**Choice**: `src/lib/portal-route-guard.ts`: sesión `portal-session` (`isLoggedIn && codigocliente`, si no 401) → `resolveRequestTenantId(req)` (null → 401) → `getTenantByIdFromDb`. Devuelve `{ tenant, session }`.
**Rejected**: `getTenantConfig()` como las rutas de portal existentes (lee `x-tenant-id` sin validar; su propio comentario dice "branding, no seguridad").

### D10 — Validación sin librería nueva
**Choice**: `src/lib/receipt-validation.ts` puro, a mano (el repo no usa zod). **Rationale**: 7 campos; no justifica una dependencia.

### D11 — Punto de extensión para C: `processReceiptFile`
**Choice**: `receipt-file.ts` expone `processReceiptFile(bytes, sniffed): Promise<ProcessResult>`. En A: PDF/JPEG/PNG/WebP → passthrough; HEIC/HEIF → `{ ok:false, code:'heic_unsupported' }`. C agrega `src/lib/receipt-image.ts` (import dinámico solo para imágenes) y cambia esas dos ramas. Plegar C en A = incluir ese archivo + deps en A. La migración ya trae `converted_from`.
**Rejected**: meter sharp/heic en A por las dudas (bundle +~9 MB y riesgo de runtime sin medir en el flujo que sí o sí tiene que salir).

### D12 — Historial del portal: primera página desde el server component, refresh con `router.refresh()`
**Choice**: `dashboard/page.tsx` trae la primera página de comprobantes (query directa, filtro tenant+codigocliente) y la pasa como `inicial` a `usePaginado`; tras un confirm OK el modal llama `router.refresh()`, y `usePaginado` ya resetea con el patrón `prevInicial` (setState durante render, sin effect).
**Rejected**: fetch en `useEffect` al montar (regla de lint: sin setState síncrono en effects); remount por `key` (pierde la página actual sin necesidad).

### D13 — Orígenes de CORS explícitos, derivados de la tabla `tenants`
**Choice**: lista concreta. Alta de tenant (o de dominio propio) = actualizar la regla CORS del bucket, con la query de DEPLOY.md. **Rejected**: `*` (prohibido); comodín de subdominio (no documentado en R2).
**Rationale**: CORS no es control de acceso (la URL firmada lo es) — es lo que permite que el navegador lea la respuesta; un origen faltante solo rompe la subida en ese dominio, con error de CORS visible en consola. Mensaje de error del modal lo cubre ("No pudimos subir el archivo").

## Data Flow

### Subida
```
Navegador (portal)                 CRM (Vercel fn)                          R2 crm-portal              Postgres
     │ POST /api/portal/comprobantes {amount,paidOn,method,…,file:{name,size,contentType}}
     │───────────────────────────────▶ requirePortalClient → r2 configurado? (503)
     │                                 validar (400/413/415 heic en A)
     │                                 rate limit Map (429) → COUNT 24h (429)
     │                                 DELETE uploading>1d / rejected>30d del tenant (lazy)
     │                                 INSERT status=uploading, declared_* ───────────────────────────▶
     │                                 presignPut(tmp/receipts/{t}/{id}, ct, size, 600s)
     │◀── 201 {id, upload:{url, method:PUT, headers:{content-type}, expiresAt}}
     │ XHR PUT url (Content-Type firmado; Content-Length lo pone el navegador)
     │──────────────────────────────────────────────────────────────────────────▶ (403 si no matchea)
     │◀─────────────────────────────────────────────────────────────── 200
     │ POST /api/portal/comprobantes/{id}/confirm
     │───────────────────────────────▶ requirePortalClient
     │                                 CLAIM: UPDATE → processing (lease 120s) ──────────────────────▶
     │                                   0 filas: SELECT → pending|loaded ⇒ 200 idempotente
     │                                            processing vivo ⇒ 202 · otro/ajeno ⇒ 404
     │                                 HEAD tmp ─────────────────────────────▶ 404 ⇒ release→uploading, 409
     │                                   size>20MB ⇒ reject 413 · size≠declared ⇒ reject 422
     │                                 GET Range 0-1023 ─────────────────────▶ sniff ⇒ null ⇒ reject 415
     │                                 GET completo (tope 20MB) ─────────────▶
     │                                 re-sniff buffer · sha256 · processReceiptFile (A: passthrough)
     │                                 PUT receipts/{t}/{yyyy-mm}/{id}.{ext} ▶ (content-type, disposition)
     │                                 UPDATE processing→pending + file_* + submitted_at ───────────▶
     │                                 DELETE tmp (best effort) ─────────────▶
     │                                 deliverReceiptEmail (lease + Resend, adjunto si ≤10MB) ───────▶ email_*
     │◀── 200 {id, status:'pending'}  (aunque el mail falle)
     │ router.refresh()  (B: historial se actualiza)

"reject X" = UPDATE processing→rejected, reject_reason=X; DELETE tmp; responder X.
Error de red/R2 inesperado = UPDATE processing→uploading (libera lease); 502 storage_error (reintentable).
```

### Visualización y acciones admin
```
Admin ─ GET /admin/comprobantes[?id=…] ─▶ page: getGuardedAdminSession() → rank<1 notFound()
                                         lista 1ª página + receiptsEmail vacío? + r2 configurado?
Admin ─ click "Ver" ─▶ GET /api/admin/comprobantes/{id}/file[?download=1]
          requireAdminPlus → SELECT WHERE tenant_id=guard AND id AND status IN (pending,loaded) (404)
          presignGet(file_key, 300s) ─▶ 302 Location: https://{acct}.r2.cloudflarestorage.com/…
Navegador sigue el 302 directo a R2 (sin CORS: es navegación / <img>)
Admin ─ PATCH {status} ─▶ UPDATE condicional (pending↔loaded, loaded_* ) ─▶ 200 fila
Admin ─ Reenviar ─▶ deliverReceiptEmail (lease 60s) ─▶ GET final si ≤10MB ─▶ Resend ─▶ 200 {email}
```

## Migración `drizzle/0023_payment_receipts.sql`

Una sola migración para A+B+C. Escrita a mano (snapshots de drizzle-kit congelados en 0013, **nunca** `db:generate`). Journal: entrada `{ "idx": 23, "version": "7", "when": 1789344000000, "tag": "0023_payment_receipts", "breakpoints": true }` (el `when` tiene que ser mayor que el de 0022, 1789257600000).

```sql
-- Comprobantes de pago informados por el cliente desde el portal (Pagos → "Informar pago").
--
-- El archivo NO vive acá: está en R2 (bucket del portal). Esta tabla guarda los metadatos,
-- el estado del circuito (subiendo → en proceso → pendiente de cargar en Alegra → cargado) y
-- el resultado del mail a la empresa.
--
-- Escrita a mano, como 0014-0022: los snapshots de drizzle-kit quedaron congelados en 0013
-- y `db:generate` regeneraría todo desde ahí.
--
-- UNA sola migración para todo el cambio (se entrega en varios PRs): un solo db:migrate en prod.
--
-- APLICAR EN PROD ANTES DE MERGEAR. `getTenantByIdFromDb` selecciona las columnas de `tenants`
-- del schema por nombre: si el código llega antes que `receipts_email`, se cae el portal y el
-- backoffice de TODOS los tenants, no solo esta feature.
--
-- Aditiva: no revertir aunque se revierta el código (el código viejo no la lee).

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "receipts_email" text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "payment_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  -- Id de contacto en Alegra, de la SESIÓN del portal (nunca del body).
  "codigocliente" text NOT NULL,
  -- Snapshot al informar: el backoffice no le pega a Alegra para listar.
  "razonsocial" text NOT NULL,
  "cuit" text NOT NULL DEFAULT '',
  "client_email" text,

  "amount" numeric(14, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'ARS',
  "paid_on" date NOT NULL,
  "method" text NOT NULL,
  "method_other" text,
  "notes" text,

  "status" text NOT NULL DEFAULT 'uploading',
  "processing_started_at" timestamptz,
  "reject_reason" text,

  -- Lo que el cliente DECLARÓ en el init (firma de la URL PUT). El confirm lo contrasta con R2.
  "declared_content_type" text NOT NULL,
  "declared_size" integer NOT NULL,

  -- Lo VERIFICADO en el confirm. file_mime es siempre el sniffeado/convertido, nunca el declarado.
  "file_key" text,
  "file_mime" text,
  "file_size" integer,
  "file_original_name" text,
  "file_sha256" text,
  "converted_from" text,

  "email_status" text NOT NULL DEFAULT 'pending',
  "email_error" text,
  "email_sent_at" timestamptz,
  "email_attempts" integer NOT NULL DEFAULT 0,
  "email_last_attempt_at" timestamptz,

  "loaded_at" timestamptz,
  "loaded_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "loaded_by_name" text,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "submitted_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "payment_receipts_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "payment_receipts_currency" CHECK ("currency" = 'ARS'),
  CONSTRAINT "payment_receipts_method" CHECK ("method" IN ('transferencia', 'cheque', 'efectivo', 'otro')),
  CONSTRAINT "payment_receipts_method_other" CHECK (
    "method" <> 'otro' OR ("method_other" IS NOT NULL AND char_length(btrim("method_other")) BETWEEN 1 AND 80)
  ),
  CONSTRAINT "payment_receipts_notes_len" CHECK ("notes" IS NULL OR char_length("notes") <= 500),
  CONSTRAINT "payment_receipts_status" CHECK ("status" IN ('uploading', 'processing', 'pending', 'loaded', 'rejected')),
  CONSTRAINT "payment_receipts_email_status" CHECK ("email_status" IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "payment_receipts_declared_size" CHECK ("declared_size" > 0 AND "declared_size" <= 20971520),
  CONSTRAINT "payment_receipts_file_size" CHECK ("file_size" IS NULL OR ("file_size" > 0 AND "file_size" <= 20971520)),
  -- Publicado ⇒ archivo verificado completo.
  CONSTRAINT "payment_receipts_published_has_file" CHECK (
    "status" NOT IN ('pending', 'loaded')
    OR ("file_key" IS NOT NULL AND "file_mime" IS NOT NULL AND "file_size" IS NOT NULL
        AND "file_sha256" IS NOT NULL AND "submitted_at" IS NOT NULL)
  ),
  CONSTRAINT "payment_receipts_processing_lease" CHECK ("status" <> 'processing' OR "processing_started_at" IS NOT NULL),
  CONSTRAINT "payment_receipts_loaded_at" CHECK (("status" = 'loaded') = ("loaded_at" IS NOT NULL))
);

-- Backoffice: lista por estado, más recientes primero.
CREATE INDEX IF NOT EXISTS "payment_receipts_tenant_status_submitted_idx"
  ON "payment_receipts" ("tenant_id", "status", "submitted_at" DESC);
-- Portal (historial del cliente), tope diario y aviso de duplicado.
CREATE INDEX IF NOT EXISTS "payment_receipts_tenant_cliente_created_idx"
  ON "payment_receipts" ("tenant_id", "codigocliente", "created_at" DESC);
```

Notas: status como `text + CHECK` (convención del repo; un `enum` de Postgres no se puede extender dentro de una transacción y el repo no usa enums). `loaded_by` sin FK de tenant: la escritura siempre usa el `user.id` del guard, que ya es del mismo tenant. `client_email` = `session.email` (replyTo al reenviar). El mail destino real **nunca** va en la migración.

`src/db/schema.ts`: `tenants.receiptsEmail: text("receipts_email").notNull().default("")` y `paymentReceipts` espejando lo de arriba (índices con `index().on(...)`; los CHECK se declaran solo en SQL — drizzle no los necesita para seleccionar). `amount` con `numeric(…, { precision: 14, scale: 2 })` → llega como **string** en TS; se serializa como string decimal (`"12345.67"`) y se formatea en la UI.

## R2

### Layout de keys
- `tmp/receipts/{tenantId}/{receiptId}` — destino del PUT. Sin extensión ni nombre del cliente. Lifecycle: borrar a 1 día.
- `receipts/{tenantId}/{yyyy-mm}/{receiptId}.{pdf|jpg|png|webp}` — final (yyyy-mm UTC de `submitted_at`). Sin expiración (respaldo contable).
- Nunca nombre original, `codigocliente` ni CUIT en la key. El primer segmento decide la retención (mismo criterio que ai-api): cambiar el prefijo sin cambiar la regla deja archivos sin expirar.

### Lifecycle (dashboard de Cloudflare, bucket `crm-portal`)
Regla "tmp-receipts-1d": prefijo `tmp/`, acción "Delete objects" a 1 día. (Opcional, misma regla: abortar multipart incompletos a 1 día — no se usan, higiene.) Sin regla sobre `receipts/`.

### CORS (formato del dashboard, listo para pegar)
```json
[
  {
    "AllowedOrigins": ["https://avantec.tevro.com.ar"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```
- Solo `PUT`: los GET del admin son navegación/`<img>` siguiendo un 302 y no requieren CORS. `content-type` en `AllowedHeaders` porque `application/pdf`/`image/*` disparan preflight.
- **Dominios propios**: cuando Central Led abra el portal en su dominio, sumar su origen (`https://` + cada host de `tenants.domains` donde se sirva el portal). `crm.*` no hace falta (es solo backoffice: el proxy lo manda a `/admin`).
- **Preview de Vercel** para la prueba de 15–20 MB: agregar temporalmente el origen exacto del preview (`https://<deploy>.vercel.app`) y sacarlo después.
- **Dev local**: `http://localhost:3000` / `http://{tenant}.localhost:3000` solo si se usa este bucket en local; preferible un bucket de dev. No es un agujero (la firma es la autorización), pero mantiene la lista corta.
- Alta de un tenant ⇒ correr y actualizar (va a `docs/DEPLOY.md`, sin valores reales):
  ```sql
  SELECT id, domains FROM tenants ORDER BY id;
  -- origen = 'https://' || id || '.' || <dominio de plataforma>   (subdominio)
  --        + 'https://' || cada host de domains donde se sirva el portal
  ```

### Token
Token nuevo "Object Read & Write" **solo** para `crm-portal` (el actual lista `crm-adjuntos`). El R2_TOKEN del `.env` local no se usa.

### Interfaz `src/lib/r2.ts`
```ts
export interface R2Config {
  accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string
  region: string // R2_REGION, default "auto" (no cuenta para "las 4 o ninguna")
}
/** Las 4 (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) o null. Parcial ⇒ null + console.error una vez. */
export function r2Config(env?: NodeJS.ProcessEnv): R2Config | null

export class R2Error extends Error {
  constructor(readonly op: "head" | "get" | "put" | "delete" | "presign", readonly status: number | null, message: string)
}
export class R2TooLargeError extends Error { constructor(readonly limit: number) }

export interface R2Deps { fetch?: typeof fetch; now?: () => Date }

export interface R2Client {
  /** URL PUT firmada por query con content-type y content-length EN los signed headers (allHeaders:true). */
  presignPut(key: string, o: { contentType: string; contentLength: number; ttlSeconds: number }):
    Promise<{ url: string; headers: { "content-type": string }; expiresAt: Date }>
  /** URL GET firmada. responseContentDisposition/Type van como response-content-* en la query. */
  presignGet(key: string, o: { ttlSeconds: number; responseContentDisposition?: string; responseContentType?: string }): Promise<string>
  head(key: string): Promise<{ size: number; contentType: string | null; etag: string | null } | null> // null = 404
  getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null>     // 206/200; null = 404
  /** Stream con contador: aborta y lanza R2TooLargeError al pasar maxBytes. */
  getObject(key: string, o: { maxBytes: number }): Promise<Uint8Array | null>
  put(key: string, body: Uint8Array, o: { contentType: string; contentDisposition?: string }): Promise<void>
  delete(key: string): Promise<void> // 204/404 ⇒ ok
}
export function createR2(cfg: R2Config, deps?: R2Deps): R2Client
/** Memoizado por proceso; null si no hay config. Es lo que mockean los tests de rutas. */
export function getR2(): R2Client | null

export const receiptKeys = {
  tmp: (tenantId: string, id: string) => `tmp/receipts/${tenantId}/${id}`,
  final: (tenantId: string, id: string, ext: string, submittedAt: Date) => string,
}
```
Implementación: endpoint path-style `https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}`; `AwsClient({ service:"s3", region })` para head/get/put/delete (firma por header); `AwsV4Signer({ method, url, headers, signQuery:true, allHeaders:true, service:"s3", region, datetime })` para presign (con `X-Amz-Expires` seteado antes de firmar). `tenantId` y `id` se validan (`/^[a-z0-9-]+$/`, uuid) antes de armar keys.

## Algoritmo del confirm (`src/lib/receipt-confirm.ts`)

`confirmReceipt({ tenant, session, id, origin }, deps: { repo, r2, deliver, now })` → `ConfirmResult`:

1. `id` no es UUID ⇒ `not_found` (evita `22P02` → 500).
2. `claim = repo.claimForConfirm(tenant.id, session.codigocliente, id, now)` (UPDATE condicional, D3).
   - Sin fila: `row = repo.findForClient(tenant.id, codigocliente, id)`:
     - `pending|loaded` ⇒ `{ ok, status: row.status }` (idempotente, **sin mail**).
     - `processing` con lease vivo ⇒ `in_progress` (202).
     - `rejected` ⇒ el mismo error con que se rechazó (`reject_reason`) — un reintento no lo resucita.
     - inexistente/ajena ⇒ `not_found` (404).
3. `head = r2.head(tmpKey)`:
   - `null` ⇒ `repo.release(id)` (→ `uploading`) ⇒ `upload_missing` (409; el cliente puede reintentar el PUT si su URL no venció o reiniciar).
   - `size > 20 MiB` ⇒ reject `file_too_large` (413).
   - `size !== declared_size` ⇒ reject `size_mismatch` (422).
4. `head8 = r2.getRange(tmpKey, 0, 1023)`; `sniffMime(head8)` null ⇒ reject `unsupported_type` (415).
5. `bytes = r2.getObject(tmpKey, { maxBytes: 20 MiB })` (R2TooLargeError ⇒ reject 413); `bytes.length !== declared_size` ⇒ reject 422.
6. `mime = sniffMime(bytes)` (re-sniff: el tmp pudo cambiar entre 4 y 5); null ⇒ reject 415.
7. `processed = processReceiptFile(bytes, mime)` — A: HEIC/HEIF ⇒ reject `heic_unsupported` (415); resto passthrough. C: convierte/stripea.
8. `sha256 = hex(sha256(processed.bytes))`; `submittedAt = now()`; `finalKey = receiptKeys.final(tenant.id, id, extFor(processed.mime), submittedAt)`.
9. `r2.put(finalKey, processed.bytes, { contentType: processed.mime, contentDisposition: inline; filename="comprobante-{paid_on}-{id8}.{ext}" })`.
10. `repo.publish(id, { fileKey, fileMime, fileSize, fileSha256, fileOriginalName: sanitizeFilename(declared name), convertedFrom, submittedAt })` = `UPDATE … SET status='pending', processing_started_at=NULL, … WHERE id AND status='processing'`. 0 filas (lease perdido por un confirm eterno) ⇒ `in_progress`, sin mail.
11. `r2.delete(tmpKey)` en try/catch (log; lifecycle cubre).
12. `deliver(receiptId)` en try/catch — nunca cambia el resultado.
13. `{ ok, status:'pending' }` (B suma `duplicateOf`: `SELECT id, submitted_at … WHERE tenant AND codigocliente AND file_sha256 = $ AND id <> $ AND status IN ('pending','loaded') LIMIT 1`).

"reject X" = `repo.reject(id, X)` (`processing → rejected`, `reject_reason`, `processing_started_at=NULL`) + `r2.delete(tmpKey)` best effort. Cualquier otra excepción (R2Error, red) ⇒ `repo.release(id)` + `storage_error` (502). Orden publish→delete tmp: un crash entre 9 y 10 se retoma (lease vence, el tmp sigue ahí, el PUT final se re-escribe en la misma key).

`export const maxDuration = 60`; `export const dynamic = "force-dynamic"`; runtime por defecto (nodejs).

### Sniff (`sniffMime`, sobre los primeros ≤1024 bytes)
- PDF: `%PDF-` (25 50 44 46 2D) en offset 0…1019 (la spec de PDF tolera basura previa; se busca en el primer KB).
- JPEG: `FF D8 FF` en 0. PNG: `89 50 4E 47 0D 0A 1A 0A` en 0. WebP: `RIFF` en 0 y `WEBP` en 8.
- HEIC/HEIF: `ftyp` en 4 y major brand (8..11) ∈ `heic heix hevc hevx heim heis mif1 msf1`.
- Todo lo demás ⇒ null (SVG, HTML, ZIP/Office, vacío). El mime declarado y la extensión no participan.

## Mail

### `src/lib/email.ts` (compatible hacia atrás)
```ts
export interface SendEmailOptions {
  from?: string                      // default tenant.resendFrom
  replyTo?: string
  attachments?: { filename: string; content: Buffer; contentType: string }[]
  tags?: { name: string; value: string }[]
  idempotencyKey?: string            // → 2º argumento de resend.emails.send
}
export async function sendEmail(tenant, to, subject, html, text?, opts?: SendEmailOptions): Promise<boolean>
```
Sin `opts` el payload es byte-idéntico al actual (cobranza en `notifications.ts`, OTP en `send-code`). Solo se agregan claves presentes. Dry-run sin `RESEND_API_KEY` sigue devolviendo `false`.

### `src/lib/receipt-email.ts` (puro, patrón `otp-email.ts`)
```ts
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024
export function formatFromAddress(displayName: string, address: string): string // quita " < > \r \n, recorta a 64
export function buildReceiptEmail(input: {
  tenantName: string
  receipt: { id; razonsocial; cuit; codigocliente; amount: string; paidOn: string; method; methodOther?; notes?;
             fileMime; fileSize; submittedAt: Date; convertedFrom? }
  adminUrl: string                       // https://{host}/admin/comprobantes?id={id}
  attachmentIncluded: boolean
}): { subject: string; html: string; text: string }
```
- **From**: `formatFromAddress(\`${tenant.name} · Comprobantes\`, RECEIPTS_EMAIL_FROM)`. Sin `RECEIPTS_EMAIL_FROM` ⇒ `skipped` (`email_error = "remitente no configurado"`), no se cae a `tenant.resendFrom` (decisión 5: remitente de plataforma).
- **To**: `tenant.receiptsEmail`; vacío ⇒ `skipped` ("mail destino no configurado").
- **replyTo**: `client_email` si parece un email.
- **Subject**: `[Comprobante de pago] {razonsocial} — $ {monto es-AR} — {dd/mm/aaaa}`, con todo `\r\n\t` y controles → espacio, colapsado, ≤ 200 chars.
- **Cuerpo** (tablas + estilos inline como OTP): título "Comprobante de pago recibido", tabla Cliente / CUIT / Código / Monto / Fecha del pago / Medio (+detalle) / Notas / Informado el / Archivo (tipo, tamaño, "convertido de HEIC" si aplica), botón "Ver en el backoffice" → `adminUrl`, y según tamaño: "Va adjunto." o "El archivo pesa X MB y no se adjunta: abrilo desde el backoffice.". Pie: "Enviado automáticamente desde el portal de clientes de {tenant}. Respondé este mail para escribirle al cliente." (solo si hay replyTo). **Todo** dato del cliente pasa por `escapeHtml` (& < > " '); en `text` sin escape pero sin controles.
- **Link**: absoluto, armado del request (`x-forwarded-proto` ?? `https` + `host` ya validado por el proxy), nunca URL firmada ni host hardcodeado. En el resend se usa el host del request del admin.
- **Adjunto** si `file_size ≤ 10 MB`: `{ filename: comprobante-{paidOn}-{id8}.{ext}, content: Buffer, contentType: file_mime }` (en el confirm, el buffer ya está en memoria; en el resend, `r2.getObject(finalKey, {maxBytes: 10MB})`).
- **Tags**: `type=payment_receipt`, `tenant={tenant.id}` (slug ASCII).

### `src/lib/receipt-delivery.ts`
`deliverReceiptEmail({ tenant, receiptId, origin, buffer? }, deps)` → `{ status: 'sent'|'failed'|'skipped'|'in_progress' }`: lease (D4) → config checks (skipped) → build → `sendEmail(..., { from, replyTo, attachments, tags, idempotencyKey: \`payment-receipt/${id}/${attempt}\` })` → `UPDATE email_status, email_error (≤500 chars), email_sent_at`. `true` ⇒ sent; `false` (dry-run) ⇒ skipped; throw ⇒ failed. Admin muestra como "mail no enviado" `failed`, `skipped` y `pending` con `submitted_at < now() - 5 min`.

## Contratos de API

Modelo de error común (todas las rutas nuevas): `{ "error": string /* castellano, mostrable */, "code": string, "fields"?: Record<string,string> }` + `Cache-Control: private, no-store`. `reason` del guard nunca va al body.

### Portal
**POST `/api/portal/comprobantes`** (A)
```ts
// Request
{ amount: string | number,        // "12345.67" — el modal normaliza "12.345,67"
  paidOn: string,                 // "YYYY-MM-DD", ≤ hoy (America/Argentina/Buenos_Aires), ≥ hoy − 2 años
  method: "transferencia" | "cheque" | "efectivo" | "otro",
  methodOther?: string,           // requerido si otro, 1..80
  notes?: string,                 // ≤ 500
  file: { name: string, size: number, contentType: string } }
// 201
{ id: string, upload: { url: string, method: "PUT", headers: { "content-type": string }, expiresAt: string } }
```
Errores: 400 `invalid` (+fields) · 401 `unauthorized` · 413 `file_too_large` (size ≤0 o >20 MiB) · 415 `unsupported_type` (fuera de pdf/jpeg/png/webp/heic/heif) · 415 `heic_unsupported` (A; se va en C) · 429 `rate_limited` (Map 10/h por `${tenant}:${codigocliente}` o COUNT ≥ 30 filas en 24 h, cualquier estado) · 503 `storage_unavailable` (sin R2). `codigocliente/razonsocial/cuit/client_email` salen de la sesión; body con esos campos se ignora.

**POST `/api/portal/comprobantes/[id]/confirm`** (A) — body vacío.
200 `{ id, status: "pending"|"loaded", duplicateOf?: { id, submittedAt } /* B */ }` · 202 `in_progress` · 401 · 404 `not_found` · 409 `upload_missing` · 413 `file_too_large` · 415 `unsupported_type`|`heic_unsupported` · 422 `size_mismatch` · 502 `storage_error` · 503 `storage_unavailable`.

**GET `/api/portal/comprobantes?start=0`** (B) — página de 10.
200 `{ comprobantes: PortalReceipt[], total: number }`
```ts
interface PortalReceipt { id: string; submittedAt: string; paidOn: string; amount: string; currency: "ARS";
  method: string; methodOther: string | null; status: "pending" | "loaded"; fileOriginalName: string | null }
```
Solo `status IN ('pending','loaded')` y `tenant_id` + `codigocliente` de la sesión. 400 si `start` inválido; 401.

### Admin (todas: `requireAdminPlus(req)` → 401 guard / 404 operator; `WHERE tenant_id = guard.tenantId`; solo `pending|loaded` visibles)
**GET `/api/admin/comprobantes?status=pending|loaded|all&email=failed&start=0&limit=25`** → 200 `{ items: AdminReceipt[], total, receiptsEmailConfigured: boolean, storageConfigured: boolean }`. `limit` 1..100; orden `submitted_at DESC, id DESC`. `email=failed` = `email_status IN ('failed','skipped') OR (pending AND submitted_at < now()-5min)`.
```ts
interface AdminReceipt { id; submittedAt; codigocliente; razonsocial; cuit; clientEmail: string|null;
  amount: string; currency: "ARS"; paidOn; method; methodOther: string|null; notes: string|null;
  status: "pending"|"loaded";
  file: { mime: string; size: number; originalName: string|null; convertedFrom: string|null };
  email: { status: "pending"|"sent"|"failed"|"skipped"; error: string|null; sentAt: string|null; attempts: number; stale: boolean };
  loaded: { at: string; byName: string|null } | null }
```
**GET `/api/admin/comprobantes/[id]`** → 200 `AdminReceipt` · 404.
**PATCH `/api/admin/comprobantes/[id]`** body `{ status: "loaded" | "pending" }` → `UPDATE … SET status=$to, loaded_at=(now()|NULL), loaded_by=(user.id|NULL), loaded_by_name=(user.name|NULL), updated_at=now() WHERE tenant AND id AND status=$from RETURNING`; 0 filas + fila ya en `$to` ⇒ 200 igual (idempotente); otra cosa ⇒ 404. 400 si body inválido. "Deshacer" limpia `loaded_*` (sin tabla de auditoría en v1: aceptado, se loguea `console.info` con user y id).
**GET `/api/admin/comprobantes/[id]/file[?download=1]`** → 302 (TTL 300 s) · 404 · 503 `storage_unavailable`.
**POST `/api/admin/comprobantes/[id]/resend-email`** → 200 `{ email: AdminReceipt["email"] }` · 409 `email_in_progress` · 404 · 503 (si hace falta el adjunto y no hay R2). `maxDuration = 60`.
**GET/PUT `/api/admin/settings/receipts`** → GET 200 `{ receiptsEmail }`; PUT `{ receiptsEmail: string }`: trim, lower-case del dominio, `""` permitido, si no: ≤254, sin `,;\s<>`, `^[^@\s]+@[^@\s]+\.[^@\s]+$` ⇒ 400 `invalid`; `UPDATE tenants SET receipts_email, updated_at WHERE id = guard.tenantId` ⇒ 200 `{ ok: true, receiptsEmail }`.

## File Changes

### PR A — flujo principal
| File | Action | Descripción |
|---|---|---|
| `drizzle/0023_payment_receipts.sql` | Create | SQL de arriba |
| `drizzle/meta/_journal.json` | Modify | entrada idx 23 |
| `src/db/schema.ts` | Modify | `tenants.receiptsEmail`, `paymentReceipts` |
| `src/lib/tenants.ts` | Modify | `TenantConfig.receiptsEmail` (DB) y `""` en `buildTenantConfig` |
| `src/lib/r2.ts` | Create | cliente R2 (interfaz arriba) |
| `src/lib/receipt-validation.ts` | Create | constantes (`MAX_FILE_BYTES`, TTLs, tipos permitidos) + `parseInitBody`, `parseAmount`, `isValidPaidOn(now)`, `parseReceiptsEmail` |
| `src/lib/receipt-file.ts` | Create | `sniffMime`, `extFor`, `sanitizeFilename`, `processReceiptFile` (A: passthrough/heic reject) |
| `src/lib/payment-receipts.ts` | Create | repositorio drizzle: `createUploading`, `cleanupStale`, `countRecentForClient`, `claimForConfirm`, `findForClient`, `release`, `reject`, `publish`, `listAdmin`, `getAdmin`, `setLoaded`, `claimEmailAttempt`, `recordEmailResult`, `toAdminDto` |
| `src/lib/receipt-confirm.ts` | Create | orquestación del confirm con deps inyectadas |
| `src/lib/receipt-email.ts` | Create | builder puro |
| `src/lib/receipt-delivery.ts` | Create | lease + envío + estado |
| `src/lib/email.ts` | Modify | `SendEmailOptions` opcional |
| `src/lib/portal-route-guard.ts` | Create | `requirePortalClient(req)` |
| `src/lib/admin-route-guard.ts` | Create | `requireAdminPlus(req)` |
| `src/lib/request-origin.ts` | Create | `requestOrigin(req)` para links del mail |
| `src/app/api/portal/comprobantes/route.ts` | Create | `POST` init (rate limit Map a nivel de módulo, patrón send-code) |
| `src/app/api/portal/comprobantes/[id]/confirm/route.ts` | Create | `POST`, `maxDuration=60` |
| `src/app/api/admin/comprobantes/route.ts` | Create | `GET` lista |
| `src/app/api/admin/comprobantes/[id]/route.ts` | Create | `GET` detalle, `PATCH` |
| `src/app/api/admin/comprobantes/[id]/file/route.ts` | Create | `GET` 302 |
| `src/app/api/admin/comprobantes/[id]/resend-email/route.ts` | Create | `POST`, `maxDuration=60` |
| `src/app/api/admin/settings/receipts/route.ts` | Create | `GET`/`PUT` |
| `src/app/admin/(protected)/comprobantes/page.tsx` | Create | guard + `notFound()`; lee `searchParams.id` y pasa `initialOpenId` |
| `src/components/admin/comprobantes/ComprobantesShell.tsx` | Create | Tabs Pendientes/Cargados/Todos, Table, Badge "mail no enviado", aviso si falta destino (link a Configuración), paginación anterior/siguiente |
| `src/components/admin/comprobantes/ComprobanteDialog.tsx` | Create | detalle, `<img src=…/file>` para imágenes, "Abrir"/"Descargar" (`window.open`) para PDF, Marcar/Deshacer, Reenviar |
| `src/components/admin/AdminShell.tsx` | Modify | NAV `{ href:"/admin/comprobantes", label:"Comprobantes", icon:<Receipt/>, minRole:"admin" }` |
| `src/components/admin/ReceiptsEmailForm.tsx` | Create | un `Field`+`Input` y Guardar |
| `src/components/admin/ConfiguracionShell.tsx` | Modify | tab `comprobantes` (admin+), prop `initialReceiptsEmail` |
| `src/app/admin/(protected)/configuracion/page.tsx` | Modify | seleccionar `tenants.receiptsEmail` (no se migra su guard: fuera de alcance) |
| `src/components/portal/InformarPagoModal.tsx` | Create | `Dialog` + `FileDropZone accept="image/jpeg,image/png,application/pdf"` + `Input` monto + `Input type=date` + `Select` medio + detalle + `Textarea` notas + `Progress`; XHR guardado en `useRef` (acceso solo en handlers), abort al cerrar; estados idle→creating→uploading→confirming→done/error, todo en handlers; en done `router.refresh()` |
| `src/components/portal/DashboardClient.tsx` | Modify | `PagosTable` monta `<Toolbar hideFilter extraActions={<Button>Informar pago</Button>} />` si `receiptsEnabled`; prop nueva propagada |
| `src/app/portal/dashboard/page.tsx` | Modify | `receiptsEnabled = r2Config() !== null` |
| `package.json` / lock | Modify | `aws4fetch` (misma versión que ai-api, 1.0.20) |
| tests (ver Testing) | Create | |
| `docs/FUNCIONALIDADES.md`, `docs/DEPLOY.md` | Modify | feature; envs, CORS/lifecycle/token, query de orígenes, orden migración→merge |

### PR B — historial en el portal
| File | Action | Descripción |
|---|---|---|
| `src/components/portal/paginado.tsx` | Create | mover **sin cambios** `usePaginado`, `Paginacion`, `useEsDesktop`, `Ventana` desde DashboardClient |
| `src/components/portal/DashboardClient.tsx` | Modify | importar de `paginado.tsx`; render de `ComprobantesInformados` en tab Pagos (bloque sobre la tabla de Alegra, solo si `total > 0`); props `comprobantes`, `comprobantesTotal` |
| `src/components/portal/ComprobantesInformados.tsx` | Create | `usePaginado({ url:"/api/portal/comprobantes", pick: d => d.comprobantes, pageSize: 10 })` + `Table` + `Badge` Pendiente/Cargado + `Paginacion` |
| `src/app/api/portal/comprobantes/route.ts` | Modify | `GET` |
| `src/lib/payment-receipts.ts` | Modify | `listPortal`, `findDuplicateBySha` |
| `src/lib/receipt-confirm.ts` + confirm route | Modify | `duplicateOf` en la respuesta |
| `src/components/portal/InformarPagoModal.tsx` | Modify | aviso "Ya nos mandaste este archivo el {fecha}" (no bloquea) |
| `src/app/portal/dashboard/page.tsx` | Modify | primera página (`Promise.allSettled` junto al resto; si falla, sección oculta — no suma a `seccionesCaidas`) |

### PR C — HEIC → JPG + strip EXIF
| File | Action | Descripción |
|---|---|---|
| `src/lib/receipt-image.ts` | Create | `normalizeImage(bytes, mime)`: HEIC/HEIF → dimensiones antes de decodificar (rechazo > 50 MP ⇒ `image_too_large` 415), `heic-decode` → `sharp(raw,{raw:{width,height,channels:4}}).resize({width:2560,withoutEnlargement:true}).jpeg({quality:82,mozjpeg:true})`; JPEG/PNG/WebP → `sharp(bytes,{limitInputPixels: 50e6}).rotate()` re-encode en su formato (sin `withMetadata` ⇒ sin EXIF/GPS). Semáforo por proceso (1 conversión a la vez) para no sumar memoria en Fluid |
| `src/lib/receipt-file.ts` | Modify | ramas de imagen → `await import("./receipt-image")`; HEIC deja de rechazarse; `convertedFrom` |
| `src/lib/receipt-validation.ts` / init route | Modify | sacar `heic_unsupported` del init |
| `next.config.ts` | Modify (si hace falta) | `serverExternalPackages: ["heic-decode", "libheif-js"]` si el tracing no los incluye o infla el bundle (sharp ya es externo automático) |
| `package.json` / lock | Modify | `sharp` directo **en la misma versión que trae next (0.34.5)**, `heic-decode` exacto; lock regenerado con `npm install` normal (con optional deps: binarios linux) |
| `test/fixtures/receipts/solid.heic` | Create | HEIC sintético generado por nosotros (color liso, sin EXIF, sin datos personales) |

## Configuración / env
| Var | Dónde | Notas |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Vercel Production + Preview | las 4 o ninguna; sin ellas: botón oculto, rutas 503 |
| `R2_REGION` | opcional | default `auto` |
| `RECEIPTS_EMAIL_FROM` | Vercel Production + Preview | dirección pelada del remitente de plataforma (dominio verificado en Resend). Nunca en código |
| `RESEND_API_KEY` | ya existe | sin ella: dry-run ⇒ `skipped` |
Envs no aplican en caliente ⇒ redeploy. `tenants.receipts_email` se carga desde Configuración (o UPDATE en prod), nunca en repo.

## Testing Strategy

Seams: `@/lib/r2` (fake en memoria `test/integration/fake-r2.ts` que implementa `R2Client`: `Map<key, {bytes, contentType}>`, contadores, inyección de fallas y de "el tmp cambió entre range y get"); `@/lib/email` (`sendEmail` spy, como `send-code.test.ts`); `iron-session` + `next/headers` mockeados (patrón `inbox-routes`); requests `new NextRequest("http://tenant-a.localhost/…")` para que `resolveRequestTenantId(req)` resuelva por host contra la DB de test. Fixtures de bytes armadas en código (`%PDF-1.4…`, header PNG, `<svg …>` con `image/png` declarado); emails `@example.com`; nombres de tenant genéricos.

| PR | Capa | Qué | Cómo |
|---|---|---|---|
| A | Unit `src/lib/r2.test.ts` | `presignPut`: `X-Amz-SignedHeaders=content-length;content-type;host`, `X-Amz-Expires`, key/bucket en el path, determinista con `now`; `presignGet` con `response-content-disposition`; `head` 404→null y parse de content-length; `getObject` aborta al pasar `maxBytes`; `delete` 404 ok; `r2Config` 4-o-ninguna | `fetch` inyectado |
| A | Unit `receipt-file.test.ts` | magic bytes de los 5 tipos, `%PDF` con prefijo, brands HEIC; SVG/HTML/ZIP/vacío → null; `sanitizeFilename` (NFKD, controles, `../`, 80 chars, extensión del mime real); `processReceiptFile` rechaza HEIC en A | puro |
| A | Unit `receipt-validation.test.ts` | monto (0, negativo, 3 decimales, >12 dígitos), `paidOn` futuro en tz AR con `vi.setSystemTime` en borde de medianoche, >2 años, `otro` sin detalle, notas 501, size 0/20 MiB/20 MiB+1, tipos, email destino | puro |
| A | Unit `receipt-email.test.ts` | escape de `<script>` en razón social/notas; subject sin `\r\n`; `formatFromAddress` con comillas/`<>`; umbral exacto 10 MiB (adjunta) / +1 byte (no, texto de aviso); link | puro |
| A | Unit `src/lib/email.test.ts` | sin opts ⇒ payload idéntico al actual y sin 2º argumento; con opts ⇒ `from/replyTo/attachments/tags` y `{ idempotencyKey }` | `vi.mock("resend")` |
| A | Unit `receipt-confirm.test.ts` | orden de pasos y ramas (upload_missing libera lease, size_mismatch, re-sniff tras cambio del tmp, storage_error libera, mail que tira no cambia el resultado, delete tmp que falla no cambia el resultado) | deps fake (repo + r2 + deliver) |
| A | Integration `test/integration/payment-receipts-portal.integration.test.ts` | init→PUT fake→confirm feliz (fi... [truncated]

---

<!-- parte 2 (guardada separada en engram por límite de 50k) -->

# Design: comprobantes-de-pago — PARTE 2 (continuación de `sdd/comprobantes-de-pago/design`)

La parte 1 se truncó a 50k chars. Esta parte repite íntegras las secciones finales, desde "Configuración / env". Si algo de la parte 1 quedó cortado en esas secciones, vale esta.

## Configuración / env
| Var | Dónde | Notas |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Vercel Production + Preview | las 4 o ninguna; sin ellas: botón oculto, rutas 503 |
| `R2_REGION` | opcional | default `auto` |
| `RECEIPTS_EMAIL_FROM` | Vercel Production + Preview | dirección pelada del remitente de plataforma (dominio verificado en Resend). Nunca en código |
| `RESEND_API_KEY` | ya existe | sin ella: dry-run ⇒ `skipped` |
Envs no aplican en caliente ⇒ redeploy. `tenants.receipts_email` se carga desde Configuración (o UPDATE en prod), nunca en repo.

## Testing Strategy

Seams: `@/lib/r2` (fake en memoria `test/integration/fake-r2.ts` que implementa `R2Client`: `Map<key,{bytes,contentType}>`, contadores, inyección de fallas y de "el tmp cambió entre range y get"); `@/lib/email` (`sendEmail` spy, como `send-code/route.test.ts`); `iron-session` + `next/headers` mockeados (patrón `inbox-routes.integration.test.ts`); requests `new NextRequest("http://tenant-a.localhost/…")` para que `resolveRequestTenantId(req)` resuelva por host (primer label) contra la DB de test. Fixtures de bytes armadas en código (`%PDF-1.4…`, header PNG, `<svg …>` declarado `image/png`); emails `@example.com`; tenants genéricos. `truncateAll` ya limpia `payment_receipts` por CASCADE desde `tenants`; igual sumarla explícita.

| PR | Capa | Qué | Cómo |
|---|---|---|---|
| A | Unit `src/lib/r2.test.ts` | `presignPut`: `X-Amz-SignedHeaders=content-length;content-type;host`, `X-Amz-Expires`, bucket/key en path, determinista con `now`; `presignGet` con `response-content-disposition`; `head` 404→null + content-length; `getObject` aborta al pasar `maxBytes`; `delete` 404 ok; `r2Config` 4-o-ninguna | `fetch` inyectado |
| A | Unit `src/lib/receipt-file.test.ts` | magic bytes de los 5 tipos, `%PDF` con prefijo, brands HEIC; SVG/HTML/ZIP/vacío → null; `sanitizeFilename` (NFKD, controles, `../`, 80 chars, ext del mime real); `processReceiptFile` rechaza HEIC en A | puro |
| A | Unit `src/lib/receipt-validation.test.ts` | monto (0, negativo, 3 decimales, >12 dígitos), `paidOn` futuro en tz America/Argentina/Buenos_Aires con `vi.setSystemTime` en borde de medianoche, >2 años, `otro` sin detalle, notas 501, size 0 / 20 MiB / 20 MiB+1, tipos, email destino | puro |
| A | Unit `src/lib/receipt-email.test.ts` | escape de `<script>` en razón social/notas; subject sin `\r\n`; `formatFromAddress` con comillas/`<>`; umbral exacto 10 MiB adjunta / +1 byte no (texto de aviso); link absoluto | puro |
| A | Unit `src/lib/email.test.ts` | sin opts ⇒ payload idéntico al actual y sin 2º argumento a `send`; con opts ⇒ `from/replyTo/attachments/tags` + `{ idempotencyKey }` | `vi.mock("resend")` |
| A | Unit `src/lib/receipt-confirm.test.ts` | orden y ramas: upload_missing libera lease; size_mismatch; re-sniff tras cambio del tmp; storage_error libera; mail que tira no cambia resultado; delete tmp que falla no cambia resultado; publish con 0 filas ⇒ in_progress sin mail | deps fake (repo, r2, deliver) |
| A | Integration `test/integration/payment-receipts-portal.integration.test.ts` | init→PUT fake→confirm feliz (fila `pending`, objeto final = bytes, tmp borrado, 1 mail); confirm ×2 secuencial ⇒ 1 mail; `Promise.all` de 2 confirms ⇒ 1 mail; SVG disfrazado ⇒ 415 + `rejected` + sin objeto en `receipts/`; >20 MiB y size_mismatch; mail que falla ⇒ `pending`+`failed`; sin R2 ⇒ 503; tope diario (sembrar 30 filas) ⇒ 429; limpieza lazy de `uploading` > 1 día; retoma de `processing` con lease vencido; cliente Y ⇒ 404 sobre comprobante de X; `codigocliente` en el body se ignora | DB real + fakes |
| A | Integration `test/integration/payment-receipts-admin.integration.test.ts` | `it.each` sobre las rutas admin nuevas + settings: sin sesión ⇒ 401; **operator ⇒ 404**; admin de tenant-b ⇒ 404 sobre comprobante de tenant-a (y la lista no lo incluye); `uploading/processing/rejected` invisibles; PATCH loaded/undo con `loaded_by_name` + idempotencia; file ⇒ 302 con `Location` del fake y `Cache-Control: private, no-store`; resend ⇒ `sent`; dos resend concurrentes ⇒ 1 envío + 409; settings PUT valida y solo toca su tenant | `seedTenant("tenant-a"/"tenant-b")`, `seedOperator(…,{role})`, helper nuevo `seedReceipt` |
| A | Manual (preview Vercel) | PDF 15–20 MB (sin adjunto, link), <10 MB (adjunto); PUT con Content-Type distinto ⇒ 403; **PUT con tamaño distinto del firmado** (registrar si R2 da 403); `response-content-disposition` honrado; CORS desde el origen del preview; operator sin nav | checklist del proposal |
| B | Integration | GET portal: solo `pending|loaded` del cliente de la sesión y del tenant del host; `total`; paginación; `Cache-Control`; `duplicateOf` en confirm | archivo portal |
| B | Manual | historial se refresca tras informar (`router.refresh`); celular "Cargar más"; lint (sin setState síncrono en effects, sin refs en render) | dev |
| C | Unit `src/lib/receipt-image.test.ts` | JPEG con EXIF/GPS generado con sharp en el test ⇒ salida sin EXIF y orientación aplicada; PNG/WebP re-encodean; HEIC fixture sintética ⇒ JPEG ≤2560 px + `convertedFrom`; tope 50 MP con decoder mockeado (no decodifica) | fixture sintética |
| C | Manual (preview) | 3–4 HEIC reales (12 y 48 MP): tiempo y memoria pico; 2–3 concurrentes; tamaño del bundle de la función | criterio para mergear C |

CI: `npm run lint`, `npm test`, `npm run test:integration`.

## Migration / Rollout
1. Cloudflare: token nuevo scopeado a `crm-portal` (Object Read & Write); CORS (JSON de la parte 1); lifecycle `tmp/` 1 día.
2. **Aplicar 0023 en prod ANTES de mergear A** (`db:migrate` a mano; verificar hash en `__drizzle_migrations`). Aditiva: el código actual convive.
3. Vercel Production + Preview: `R2_*`, `RECEIPTS_EMAIL_FROM` + redeploy.
4. Preview de A (con su origen agregado temporalmente al CORS): checklist manual.
5. Merge A. Cargar el mail destino desde Configuración.
6. B y C después; C solo con la medición HEIC OK (si no, A sigue rechazando HEIC con mensaje claro).

Rollback: revert del merge (o Instant Rollback); **no** revertir 0023; objetos de `receipts/` se conservan; apagar sin revert = quitar `R2_*` + redeploy (botón oculto, rutas 503); problema de remitente = vaciar `RECEIPTS_EMAIL_FROM` ⇒ `skipped`.

## Risks
| Riesgo | Mitigación |
|---|---|
| Port literal de ai-api sin `allHeaders:true` ⇒ URL PUT que no ata tipo ni tamaño, sin error visible | D7 + unit test de `SignedHeaders`; HEAD autoritativo |
| R2 no hace cumplir `content-length` firmado (no documentado) | HEAD + GET con tope en confirm; lifecycle 1 día; rate limit; prueba en preview |
| Código antes que 0023 ⇒ cae portal y admin de todos los tenants | Rollout paso 2; comentario en el `.sql` y en el PR |
| **Sesión del portal sin `tenantId`**: si `COOKIE_DOMAIN` llegara a abarcar subdominios de dos tenants (ej. dominio de plataforma), una cookie de A sería válida en B con un `codigocliente` de otro Alegra. Hoy no pasa (dominios raíz distintos / cookie host-only) y afecta a todo el portal, no solo a esto | Follow-up recomendado: guardar `tenantId` en `portal-session` en `verify-code` y validarlo en `requirePortalClient` (el helper centraliza el lugar). No se hace en este cambio |
| CORS incompleto (dominio propio no listado) ⇒ subida rota solo ahí | Query de orígenes en DEPLOY.md; error visible en el modal |
| TOCTOU sobre `tmp/` (el cliente re-PUT con la URL aún viva) | D2: se publica el buffer verificado |
| Doble mail / doble publicación | D3 + D4 + tests de concurrencia |
| Invocación que excede 60 s y sigue viva mientras otra retoma el lease | `publish` exige `status='processing'`; si otro publicó, el primero no manda mail |
| `response-content-*` no honrado por R2 | inline ya funciona por metadatos del PUT; solo "Descargar" dependería; fallback: abrir inline |
| Memoria/CPU HEIC en Fluid, bundle +~9 MB | C separado, tope 50 MP, semáforo por proceso, medición |
| `amount` numeric llega como string en drizzle | se trata como string decimal hasta la UI; nunca `parseFloat` para guardar |
| Filas `rejected`/`uploading` acumuladas | limpieza lazy en init (uploading > 1 día, rejected > 30 días, por tenant) |

## Open Questions
- [ ] ¿R2 rechaza un PUT cuyo tamaño difiere del `content-length` firmado? No documentado; se registra en el preview (no bloquea).
- [ ] ¿R2 honra `response-content-disposition` en GET prefirmado? Verificar en preview (no bloquea; fallback descrito).
- [ ] ¿En qué host(s) sirve Central Led el portal cuando lo abra? Define su origen CORS; hoy solo Avantec usa el portal.
- [ ] API exacta de `heic-decode` para leer dimensiones sin decodificar; si no las expone, parsear la caja `ispe` antes de decodificar (C).
- [ ] ¿Se agrega `tenantId` a la sesión del portal? Follow-up, fuera de este cambio.

## Desviaciones respecto del proposal
1. Estados `processing` y `rejected` (+ `processing_started_at`, `reject_reason`), `declared_content_type/size`, `client_email`, `email_attempts/last_attempt_at`, `updated_at`: necesarios para idempotencia, locking y tope anti-abuso. Todo dentro de 0023.
2. El confirm publica con PUT desde el buffer verificado, no CopyObject (D2, cierra TOCTOU).
3. El botón no va en un Toolbar existente de Pagos (no hay desde #112): se monta `<Toolbar hideFilter extraActions>`.
4. B mueve `usePaginado`/`Paginacion`/`useEsDesktop` a `src/components/portal/paginado.tsx`.
5. CORS con lista explícita (sin `https://*.tevro.com.ar` del checklist del proposal): comodines no documentados en R2.
6. Link del mail absoluto (un relativo no funciona en un cliente de correo), armado del host del request.
7. Rutas nuevas del portal usan `resolveRequestTenantId(req)` en vez de `getTenantConfig()`.