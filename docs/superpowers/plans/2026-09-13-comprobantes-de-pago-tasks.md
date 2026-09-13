# Tasks: comprobantes-de-pago

Fuentes: spec #221 + spec-part-2 #222, design #224 + design-part2 #225, proposal #220. Manda la spec en QUÉ, el design en CÓMO.
Etiquetas: [unit] vitest unit · [int] integración crm_test · [manual-preview] preview de Vercel · [ops] fuera del repo. IDs de spec abreviados: DM=data-model, ST=storage, FV=file-validation, PS=portal-submission, PH=portal-history, EM=email, AR=admin-receipts, TS=tenant-settings, TH=tests-hygiene.
REPO PÚBLICO: fixtures con `@example.com`/`ejemplo.com`, tenants `tenant-a`/`tenant-b`, datos inventados. Nunca el mail destino real, el remitente, URLs de prod ni orígenes CORS reales en código/tests/docs/PR.

## Conciliación spec ↔ design (decidir al aplicar, ya resuelto así)
- Estados: la migración trae los 5 del design (`uploading, processing, pending, loaded, rejected`); `processing`/`rejected` son internos y NUNCA visibles (cumple DM "máquina de estados": las transiciones públicas siguen siendo las de la spec).
- Rate limit diario: spec = 20 filas no-`uploading` en 24 h; design = 30 de cualquier estado. Usar constante con nombre `RECEIPTS_DAILY_LIMIT = 20` contando `status <> 'uploading'` (incluye `rejected`, anti-abuso). Por hora: 10 (Map).
- Init responde 201 (design) — la spec dice 200: aceptar 2xx en tests; preferir 201.
- size_mismatch: spec 413 en confirm, design 422. Usar 413 (spec). 50 MP en C: 415.
- Resend con destino/from/API key faltante: 409 (spec); en lease ocupado 409 `email_in_progress`.
- Limpieza lazy de `uploading` > 24 h (spec) y `rejected` > 30 días.
- Higiene drizzle/postgres-js: las fechas crudas (`Date`) interpoladas en fragments `sql` llegan al driver sin serializar y postgres-js tira `TypeError` (no hay columna que las mapee). Comparaciones de fechas SIEMPRE con operadores drizzle (`gte`/`lt`/`isNull`/`or`/`and`), que pasan el valor por el mapper de la columna. Los `.set()`/`.values()` sí serializan solos.

---

## ENTREGA A — storage + subida + mail + admin + Configuración + migración 0023 (rechaza HEIC)

### A0. Ops pre-merge (bloqueantes)
- [x] A0.1 [ops] Token R2 re-scopeado a `crm-portal` (Object R&W). VERIFICADO: 403 sobre `crm-adjuntos`. (ST bucket)
- [ ] A0.2 [ops] CORS del bucket `crm-portal`: `AllowedMethods:["PUT"]`, `AllowedHeaders:["content-type"]`, orígenes explícitos del portal (sin `*` ni comodín) + origen exacto del preview temporal. (ST bucket, D13)
- [ ] A0.3 [ops] Lifecycle `tmp/` → borrar a 1 día; nada sobre `receipts/`. (ST bucket, PS huérfanos)
- [x] A0.4 [ops] Aplicar `0023` en PROD ANTES DE MERGEAR (`db:migrate` a mano; verificar hash en `__drizzle_migrations`, ver memoria drizzle-desync). (DM 0023, DM TenantConfig) — ✅ 2026-09-13: aplicada contra Neon vía `.env.prod`, hash == sha256 del SQL, `payment_receipts` + `tenants.receipts_email` + 15 constraints verificados en prod (24 migraciones en `drizzle.__drizzle_migrations`).
- [ ] A0.5 [ops] Vercel Production + Preview: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `RECEIPTS_EMAIL_FROM` → redeploy. (ST config, EM contenido)
- [ ] A0.6 [manual-preview] Checklist en preview: PDF 15–20 MB sube+confirma sin 413, sha256 igual, mail sin adjunto con link, admin abre por 302; archivo <10 MB con adjunto; PUT con Content-Type distinto ⇒ 403; PUT con tamaño distinto (registrar si R2 da 403); `response-content-disposition` honrado; operator sin nav. Sacar el origen del preview del CORS al terminar. (ST bytes, EM adjunto, TH manual)
- [ ] A0.7 [ops] Post-merge: cargar el mail destino desde Configuración → Comprobantes del tenant. (TS)

### A1. Migración y modelo
- [x] A1.1 Crear `drizzle/0023_payment_receipts.sql` a mano con el SQL del design (aditivo, `IF NOT EXISTS`, comentario "APLICAR EN PROD ANTES DE MERGEAR", sin INSERT/UPDATE de datos). NUNCA `db:generate`. (DM 0023, DM restricciones)
- [x] A1.2 `drizzle/meta/_journal.json`: entrada idx 23, tag `0023_payment_receipts`, `when` > 0022. (DM 0023)
- [x] A1.3 `src/db/schema.ts`: `tenants.receiptsEmail` + tabla `paymentReceipts` (amount numeric → string). (DM)
- [x] A1.4 `src/lib/tenants.ts`: `TenantConfig.receiptsEmail` desde DB; `""` en `buildTenantConfig`. (DM TenantConfig)
- [x] A1.5 [int] Migración idempotente (aplicar 2 veces), CHECK rechaza `status='aprobado'` y `amount=0`, borrar admin deja `loaded_by NULL` y `loaded_by_name`. `truncateAll` incluye `payment_receipts`. (DM escenarios)

### A2. Librerías puras
- [x] A2.1 `npm i aws4fetch@1.0.20`. `src/lib/r2.ts`: `r2Config` (4 o ninguna), `createR2`, `getR2` memoizado, `R2Error`, `R2TooLargeError`, `receiptKeys` (valida tenantId/uuid). `presignPut` con `AwsV4Signer({signQuery:true, allHeaders:true, ...})` y `X-Amz-Expires` 600 s; `presignGet` TTL 300 s con `response-content-*`. (ST keys, ST URL PUT, ST URL lectura, D7)
- [x] A2.2 [unit] `src/lib/r2.test.ts` (`fetch` inyectado): assert `X-Amz-SignedHeaders=content-length;content-type;host`, `X-Amz-Expires` en 300–600, bucket/key en path; `presignGet` con disposition/type; head 404→null; `getObject` aborta >maxBytes; delete 404 ok; `r2Config` parcial→null. (TH #5)
- [x] A2.3 `src/lib/receipt-file.ts`: `sniffMime` (PDF/JPEG/PNG/WebP/HEIC brands), `extFor`, `sanitizeFilename`, `processReceiptFile` (A: passthrough; HEIC/HEIF → `heic_unsupported` con el mensaje de la spec). (FV magic bytes, FV nombre, FV HEIC [A], D11)
- [x] A2.4 [unit] `receipt-file.test.ts`: 5 tipos, SVG/HTML/ZIP/vacío→null, SVG declarado png→null, nombre hostil (NUL U+0000 construido con `String.fromCharCode(0)`, NO escape literal), `..`, `<>`, ≤80, ext del mime real; HEIC rechazado. (TH #1 #2 #3)
- [x] A2.5 `src/lib/receipt-validation.ts`: constantes (`MAX_FILE_BYTES=20971520`, `ATTACH_MAX_BYTES`, TTLs, límites rate), `parseInitBody`, `parseAmount`, `isValidPaidOn(now)` en tz AR, `parseReceiptsEmail`. (PS init, FV 20 MB, TS)
- [x] A2.6 [unit] `receipt-validation.test.ts`: monto 0/neg/3 dec/>max, fecha futura en borde de medianoche AR (`vi.setSystemTime`), `otro` sin detalle, notas 501, size 0/20MiB/20MiB+1, tipos (svg→415, heic→415), email con coma/`;`/CRLF/vacío. (TH #6)
- [x] A2.7 `src/lib/email.ts`: `SendEmailOptions {from, replyTo, attachments, tags, idempotencyKey}` opcional; sin opts payload idéntico. (EM sendEmail)
- [x] A2.8 [unit] `src/lib/email.test.ts` (`vi.mock("resend")`): sin opts igual que antes y sin 2º arg; con opts pasa todo + `{idempotencyKey}`. (TH #7)
- [x] A2.9 `src/lib/receipt-email.ts`: `formatFromAddress`, `buildReceiptEmail` (subject prefijo exacto sin CR/LF, escape HTML, link absoluto `/admin/comprobantes?id=`, aviso >10 MB). (EM contenido, EM adjunto)
- [x] A2.10 [unit] `receipt-email.test.ts`: escape `<img onerror>`/`<script>`, CRLF+Bcc en razón social, 10485760 adjunta / +1 no, sin replyTo, from `"Empresa Demo · Comprobantes" <...@example.com>`. (TH #4)

### A3. Guards, repo y orquestación
- [x] A3.1 `src/lib/admin-route-guard.ts` `requireAdminPlus(req)`: `getGuardedAdminSession(req)` → 401; `roleRank(rol de DB) < 1` → 404 cuerpo idéntico a inexistente. Nunca `session.role`/`session.tenantId`. (AR guard, D8)
- [x] A3.2 `src/lib/portal-route-guard.ts` `requirePortalClient(req)`: sesión `isLoggedIn && codigocliente` (401) + `resolveRequestTenantId(req)` (null→401) + `getTenantByIdFromDb`. (PS aislamiento, D9)
- [x] A3.3 `src/lib/request-origin.ts` `requestOrigin(req)`. (EM link)
- [x] A3.4 `src/lib/payment-receipts.ts` repo drizzle: `createUploading`, `cleanupStale`, `countRecentForClient`, `claimForConfirm` (UPDATE condicional lease 120 s), `findForClient`, `release`, `reject`, `publish` (WHERE status='processing'), `listAdmin`, `getAdmin`, `setLoaded`, `claimEmailAttempt` (lease 60 s), `recordEmailResult`, `toAdminDto`. Todo filtra `tenant_id` AND `id`. (DM estados, PS idempotente, AR aislamiento, D3 D4)
- [x] A3.5 `src/lib/receipt-delivery.ts` `deliverReceiptEmail`: lease → skipped si falta `RESEND_API_KEY`/`RECEIPTS_EMAIL_FROM`/`receiptsEmail` → build → `sendEmail` con `idempotencyKey=payment-receipt/{id}/{attempt}` → sent/failed (error ≤500 chars sin secretos). (EM estado, D4)
- [x] A3.6 `src/lib/receipt-confirm.ts` `confirmReceipt` con deps inyectadas, pasos 1–13 del design (HEAD → range sniff → GET con tope → re-sniff → sha256 sobre bytes subidos → PUT final desde buffer (no CopyObject) → publish → delete tmp best effort → mail try/catch). (PS confirm, FV 20 MB, FV hash, D2)
- [x] A3.7 [unit] `receipt-confirm.test.ts`: upload_missing libera lease (409); >20MB/size_mismatch→413; tmp cambiado entre range y get → re-sniff rechaza; storage_error libera (502); mail que tira no cambia 200; delete tmp que falla no cambia; publish 0 filas ⇒ in_progress sin mail; HEIC→415. (TH, FV)

### A4. Rutas
- [x] A4.1 `src/app/api/portal/comprobantes/route.ts` POST init: guard → 503 sin R2 → validar → rate limit Map 10/h + COUNT diario → cleanup lazy → INSERT uploading (datos de sesión, body ignorado) → presignPut. `Cache-Control: private, no-store`. (PS init, PS rate limit, PS huérfanos, ST config)
- [x] A4.2 `src/app/api/portal/comprobantes/[id]/confirm/route.ts` POST, `maxDuration=60`, `dynamic="force-dynamic"`, `params` es Promise. (PS confirm)
- [x] A4.3 `src/app/api/admin/comprobantes/route.ts` GET lista (status default pending, ≤50, sin URLs firmadas, `receiptsEmailConfigured`, `storageConfigured`). (AR listado, ST listado sin URLs)
- [x] A4.4 `src/app/api/admin/comprobantes/[id]/route.ts` GET detalle + PATCH loaded/pending idempotente, `loaded_by_name` de DB, `console.info` de auditoría estructurado, 400 otro status. (AR marcar/deshacer)
- [x] A4.5 `src/app/api/admin/comprobantes/[id]/file/route.ts` GET → `NextResponse.redirect(url, 302)` con `Cache-Control: private, no-store` + `Referrer-Policy: no-referrer`; 404 ajeno/uploading/objeto ausente; 503 sin R2. Sin bytes en body. (AR ver archivo, ST bytes)
- [x] A4.6 `src/app/api/admin/comprobantes/[id]/resend-email/route.ts` POST `maxDuration=60`: 200/409 config o lease/502 proveedor; no toca `status`. (EM reenviar)
- [x] A4.7 `src/app/api/admin/settings/receipts/route.ts` GET/PUT: un solo email o vacío, solo tenant del guard, ignora `tenantId` del body. (TS)

### A5. UI
- [x] A5.1 `src/app/admin/(protected)/comprobantes/page.tsx`: `getGuardedAdminSession()` + `notFound()` si rank<1; `searchParams.id` → `initialOpenId` ("Comprobante no encontrado" si ajeno). (AR operator, AR listado)
- [x] A5.2 `src/components/admin/comprobantes/ComprobantesShell.tsx` (tabs Pendientes/Cargados, tabla, badge "Mail no enviado", aviso destino vacío con link a Configuración, paginación) y `ComprobanteDialog.tsx` (Ver/Descargar vía `/file`, Marcar/Deshacer con confirmación, Reenviar). (AR)
- [x] A5.3 `src/components/admin/AdminShell.tsx`: NAV `Comprobantes`, icono `Receipt`, `minRole:"admin"`. (AR operator)
- [x] A5.4 `src/components/admin/ReceiptsEmailForm.tsx` + tab `comprobantes` (admin+) en `ConfiguracionShell.tsx` + `configuracion/page.tsx` pasa `initialReceiptsEmail`. (TS)
- [x] A5.5 `src/components/portal/InformarPagoModal.tsx`: FileDropZone `accept="image/jpeg,image/png,application/pdf"`, check 20 MB en cliente, monto/fecha `<Input type=date>`/medio/detalle/notas, XHR con `Progress` en ref, estados en handlers (sin setState en effects), error recuperable de PUT sin llamar confirm, éxito "Recibimos tu comprobante" + `router.refresh()`. (PS botón y modal, FV HEIC [A])
- [x] A5.6 `DashboardClient.tsx`: `PagosTable` monta `<Toolbar hideFilter extraActions={Informar pago}>` si `receiptsEnabled`; `portal/dashboard/page.tsx` pasa `receiptsEnabled = r2Config() !== null`. (PS botón, ST degradación)

### A6. Tests de integración (mocks: `@/lib/r2` con `test/integration/fake-r2.ts`, `@/lib/email` spy, iron-session/next/headers; `NextRequest("http://tenant-a.localhost/...")`)
- [x] A6.1 Crear `test/integration/fake-r2.ts` (Map, contadores, fallas inyectables, mutación de tmp) y helper `seedReceipt`.
- [x] A6.2 [int] `test/integration/payment-receipts-portal.integration.test.ts`: happy path (pending, objeto final = bytes, tmp borrado, 1 mail); confirm ×2 y `Promise.all` ⇒ 1 mail, `submitted_at` estable; SVG como png ⇒ 415 sin objeto final; >20 MiB ⇒ 413; mail falla ⇒ pending+failed; sin destino ⇒ skipped; sin R2 ⇒ 503 y `/api/portal/pagos` sigue OK; tope diario ⇒ 429 y cuota separada para otro cliente; cleanup uploading >24h sin tocar pending; lease vencido se retoma; X confirma de Y y mismo codigocliente en tenant-b ⇒ 404 idéntico; `codigocliente` en body ignorado. (TH #10 #11 #12 #14 #15)
- [x] A6.3 [int] `test/integration/payment-receipts-admin.integration.test.ts` con `it.each` sobre las 5 rutas + settings: sin sesión 401; operator 404 sin efectos; cookie con rol viejo (DB operator) 404; admin tenant-b ⇒ 404 sobre tenant-a y lista sin mezcla; uploading/processing/rejected invisibles; PATCH loaded/undo/idempotente/400; file ⇒ 302 `Location` del fake + no-store; resend failed→sent, 502, 409 sin destino, 2 concurrentes ⇒ 1 envío; settings PUT valida y solo toca su tenant. (TH #8 #9 #12 #13 #16)
- [x] A6.4 `npm run lint && npm test && npm run test:integration` en verde. (2026-09-13: lint 0 errors · unit 209 ✓ · integration 135 ✓; el error de lint pre-existente en InboxList.tsx se arregló de yapa: `mounted` pasó a `useSyncExternalStore`.)

### A7. Docs e higiene
- [x] A7.1 `docs/FUNCIONALIDADES.md`: quién informa/ve, estados, mail, 20 MB/10 MB, HEIC rechazado. (TH docs)
- [x] A7.2 `docs/DEPLOY.md`: envs (Prod+Preview+redeploy), token scopeado, CORS sin `*` (alta de tenant/dominio = actualizar CORS, query genérica sin valores reales), lifecycle `tmp/`, orden 0023→merge, rollback (no revertir 0023; apagar = quitar `R2_*`). (TH docs, ST bucket)
- [x] A7.3 Grep del diff por dominios reales/remitente/URLs prod antes de abrir PR; descripción del PR con "APLICAR EN PROD ANTES DE MERGEAR". (TH sin datos reales) — scrubbed: `comprobantes@<dominio-real>` y mail de cliente real de los docs de spec; el diff de código/tests quedó limpio. Falta solo la descripción del PR al abrirlo.

---

## ENTREGA B — historial del portal + aviso de duplicado (sin migraciones)
- [x] B1 Mover SIN cambios `usePaginado`, `Paginacion`, `useEsDesktop` (y `Ventana`) de `DashboardClient.tsx` a `src/components/portal/paginado.tsx`; importar desde ahí. (D12)
- [x] B2 `payment-receipts.ts`: `listPortal` (pending|loaded, tenant+codigocliente, submitted_at desc, página 10) y `findDuplicateBySha` (mismo tenant+cliente, id distinto). (PH listado, PH duplicado)
- [x] B3 `GET` en `src/app/api/portal/comprobantes/route.ts`: `requirePortalClient`, DTO sin `loaded_by*`, `email_*`, `file_key`, `file_sha256`, URLs; no-store; 400 start inválido. (PH listado)
- [x] B4 `receipt-confirm.ts` + ruta confirm: `duplicateOf {id, submittedAt}` (no bloquea); mail con "Posible duplicado de un comprobante del {fecha}". (PH duplicado)
- [x] B5 `src/components/portal/ComprobantesInformados.tsx` (Table + Badge Pendiente/Cargado + Paginacion) en tab Pagos; `portal/dashboard/page.tsx` trae primera página con `allSettled` (si falla, sección oculta). Modal muestra aviso de duplicado; `router.refresh()` refresca. (PH)
- [x] B6 [int] Historial solo propio (sin Y, sin otro tenant, sin uploading, sin "Ana"), paginación, no-store, `duplicateOf` solo mismo cliente/tenant. (TH #17)
- [x] B7 lint 0 err · unit 209 ✓ · integration 140 ✓ · `tsc --noEmit` 0 (fix de yapa: tupla `CASES[]` en el test admin de A). `git status --short drizzle/` = solo 0023 (de A). Falta la validación manual en preview (refresco tras informar, mobile "Cargar más") — va junto con A0.6.

## ENTREGA C — HEIC→JPG + strip EXIF (sin migraciones; mergear solo si la medición pasa)
- [x] C1 `npm i sharp@0.34.5 heic-decode@2.1.0`; `next.config.ts` `serverExternalPackages` para heic-decode/libheif-js (sharp ya es externo automático).
- [x] C2 `src/lib/receipt-image.ts` `normalizeImage`: dimensiones antes de decodificar (>50 MP ⇒ 415 "La imagen es demasiado grande"; heic-decode no expone dimensiones ⇒ se parsea la caja `ispe`), resize 2560 sin agrandar, JPEG q82, `rotate()` sin metadata, semáforo por proceso; fallo ⇒ 422.
- [x] C3 `receipt-file.ts`: import dinámico para imágenes, `convertedFrom`; `heic_unsupported` fuera de init y confirm (errores nuevos: `image_too_large` 415 / `processing_failed` 422); modal acepta HEIC (el `accept` quedó igual).
- [x] C4 [unit] `receipt-image.test.ts` con fixture sintética `test/fixtures/receipts/solid.heic` (color liso generado con sips, sin EXIF) y JPEG con EXIF Orientation=6 + GPS generado en el test: orientación aplicada, sin EXIF, ≤2560 px, 50 MP con decoder espiado (no decodifica), corrupto ⇒ 422. (TH #18). Hallazgo: la API real de heic-decode 2.x es `decode({ buffer })`, no `decode(buffer)` — tipos propios en `src/types/heic-decode.d.ts`.
- [ ] C5 [manual-preview] 3–4 HEIC reales (12 y 48 MP) y 2–3 concurrentes: tiempo < 60 s, memoria pico y tamaño de bundle aceptables. **Bloquea el merge de C** (revertir los commits de C deja A+B intactos); va en el checklist del PR #113.
- [x] C6 `docs/FUNCIONALIDADES.md`: HEIC convertido + strip EXIF.
- [x] C7 Gates: lint 0 err · unit 218 ✓ · integration 140 ✓ · `tsc --noEmit` 0.
- PR: https://github.com/MyD-Org/CRM/pull/113 (incluye A+B+C; commit `eb236df`).

## Orden
A0.1–A0.3 en paralelo con A1–A3 → A4 → A5 → A6 → A7 → A0.4 + A0.5 → A0.6 → merge A → A0.7. Luego B; C independiente de B.
