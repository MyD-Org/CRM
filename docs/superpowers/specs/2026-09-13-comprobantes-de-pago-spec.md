# Spec: comprobantes-de-pago (PARTE 1 de 2)

**La spec está partida en dos observaciones por el límite de tamaño de engram. Leer ambas:**
- Parte 1 (esta): `sdd/comprobantes-de-pago/spec` — invariantes, `receipts-data-model`, `receipts-storage`, `receipt-file-validation`, `portal-receipt-submission`, `portal-receipt-history`.
- Parte 2: `sdd/comprobantes-de-pago/spec-part-2` — `receipt-notification-email`, `admin-receipts`, `tenant-receipts-settings`, `receipts-tests-and-hygiene`, trazabilidad.

Base: `main`. Depende de `sdd/comprobantes-de-pago/proposal` (engram #220) y `sdd/comprobantes-de-pago/explore` (#218). Formato de referencia: `sdd/admin-tenant-guard/spec` (#166).

**Baseline**: no hay specs previos de estos dominios. Casi todo es spec **nueva** (feature que no existe). Las secciones MODIFIED citan `(Previamente: ...)` con la conducta real de `main` (`sendEmail`, `TenantConfig`, nav admin, Configuración).

**Invariantes rectores** (valen para todos los dominios; cualquier requisito que parezca contradecirlos está mal leído):

1. **Los bytes del archivo nunca atraviesan una Vercel Function ni `src/proxy.ts`, en ninguna dirección.** Límite verificado: 4,5 MB de body de request **y** de response (413 `FUNCTION_PAYLOAD_TOO_LARGE`); el proxy de Next 16 trunca en silencio bodies > 10 MB. Subida = PUT prefirmado a R2; visualización/descarga = redirect a URL firmada corta. (La función SÍ puede *leer* el objeto desde R2 para validar, convertir y adjuntar: eso no es body de la invocación.)
2. **Aislamiento**: portal → `tenant_id` del host + `codigocliente` de la sesión; admin → `getGuardedAdminSession(req)` (tenant del host + rol fresco de DB). Lo ajeno o inexistente responde **404**, nunca 403, con cuerpo indistinguible.
3. **Solo `admin` y `superadmin`** ven y operan comprobantes. `operator` = la feature no existe (nav oculta, 404).
4. **El tipo de archivo se decide por magic bytes**, nunca por extensión, `Content-Type` declarado ni nombre.
5. **Repo público**: ni el mail destino de ningún tenant real, ni la dirección remitente, ni URLs de prod, ni datos reales de clientes en código, migración, tests, fixtures, docs de ejemplo ni descripción de PR.

**Etiquetas de entrega**: cada requisito lleva `[A]`, `[B]` o `[C]`.
- **A** — storage + subida + mail + admin + Configuración + **toda** la migración `0023`.
- **B** — historial del cliente en el portal + aviso de duplicado.
- **C** — HEIC→JPG + strip de EXIF + resize.
Los requisitos de HEIC están escritos en par (`HEIC rechazado [A]` / `HEIC convertido [C]`): si el usuario pide adelantar HEIC a A, se reemplaza el primero por el segundo sin tocar nada más.

Defaults del proposal vigentes: solo ARS; notas opcionales; un archivo por comprobante; el archivo final no se borra nunca en v1; operator recibe 404; HEIC convertido se redimensiona a 2560 px.

Dominios:

| Dominio | Entrega | Parte | Alcance |
|---|---|---|---|
| `receipts-data-model` | A | 1 | Migración 0023, schema, estados |
| `receipts-storage` | A | 1 | R2, keys, URLs firmadas, bucket |
| `receipt-file-validation` | A (+C) | 1 | Tamaño, magic bytes, nombre, HEIC, EXIF |
| `portal-receipt-submission` | A | 1 | Init, PUT, confirm, idempotencia, huérfanos, rate limit, UI |
| `portal-receipt-history` | B | 1 | Listado del cliente, aviso de duplicado |
| `receipt-notification-email` | A | 2 | Mail a la empresa, `sendEmail`, reenvío |
| `admin-receipts` | A | 2 | Pantalla, lista, archivo, marcar/deshacer, reenviar, roles |
| `tenant-receipts-settings` | A | 2 | Mail destino por tenant |
| `receipts-tests-and-hygiene` | A/B/C | 2 | Suite obligatoria, repo público, docs |

---

# receipts-data-model Specification

## Purpose

Persistir cada comprobante informado con aislamiento por tenant y cliente, su archivo, el estado del mail y la auditoría de carga en Alegra.

## Requirements

### Requirement: Una sola migración aditiva `0023` [A]

El cambio MUST introducir exactamente una migración nueva, `drizzle/0023_payment_receipts.sql`, con su entrada en `drizzle/meta/_journal.json` (idx 23), aunque la entrega se divida en varios PRs. La migración MUST:
- ser aditiva (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), sin `DROP` ni `ALTER` destructivos;
- llevar el comentario "APLICAR EN PROD ANTES DE MERGEAR" (estilo 0022);
- agregar `tenants.receipts_email text NOT NULL DEFAULT ''`;
- crear `payment_receipts` con los campos del proposal (identidad, snapshot del cliente, pago, estado, archivo, mail, auditoría de carga) e índices `(tenant_id, status, created_at)` y `(tenant_id, codigocliente, created_at)`;
- MUST NOT contener ningún `INSERT`/`UPDATE` con datos de tenants reales (el mail destino se carga desde Configuración o por UPDATE manual en prod).

Los PRs B y C MUST NOT agregar migraciones.

#### Scenario: Migración idempotente

- GIVEN una DB `crm_test` con `0022` aplicada
- WHEN se aplica el SQL de `0023` dos veces
- THEN la segunda aplicación no falla
- AND existen `tenants.receipts_email` y la tabla `payment_receipts` con ambos índices

#### Scenario: Código viejo convive con la migración

- GIVEN `0023` aplicada y el código de `main` previo al cambio desplegado
- WHEN se usan portal y admin
- THEN todo funciona igual (la migración es aditiva)

#### Scenario: B y C no migran

- GIVEN las ramas de las entregas B y C
- WHEN se hace `git diff <base> -- drizzle/`
- THEN el diff está vacío

### Requirement: Restricciones de dominio en la tabla [A]

`payment_receipts` MUST garantizar a nivel DB:
- `amount numeric(14,2)` con CHECK `amount > 0`;
- `currency` con default `'ARS'` (única moneda soportada en v1);
- `method` CHECK ∈ {`transferencia`, `cheque`, `efectivo`, `otro`};
- `status` CHECK ∈ {`uploading`, `pending`, `loaded`}, default `uploading`;
- `email_status` CHECK ∈ {`pending`, `sent`, `failed`, `skipped`}, default `pending`;
- `tenant_id` FK a `tenants`; `loaded_by` FK a `admin_users` `ON DELETE SET NULL`, con `loaded_by_name` como snapshot.

#### Scenario: Valor fuera de dominio rechazado por la DB

- GIVEN la tabla creada
- WHEN se intenta insertar una fila con `status = 'aprobado'` o `amount = 0`
- THEN la DB rechaza el insert

#### Scenario: Borrar el admin que cargó no pierde el nombre

- GIVEN un comprobante `loaded` con `loaded_by = U` y `loaded_by_name = "Ana"`
- WHEN se borra la fila `U` de `admin_users`
- THEN el comprobante conserva `status = 'loaded'`, `loaded_by = NULL` y `loaded_by_name = "Ana"`

### Requirement: Máquina de estados [A]

Las únicas transiciones válidas de `status` MUST ser:
- `uploading → pending` (solo por confirm exitoso del cliente dueño);
- `pending → loaded` y `loaded → pending` (solo admin+ del mismo tenant).

Una fila `uploading` MUST NOT ser visible ni operable fuera del flujo de confirm (ni en admin, ni en el historial del portal, ni para mail). Ninguna transición MUST volver a `uploading`.

#### Scenario: Admin no puede operar una fila `uploading`

- GIVEN un comprobante `uploading` del tenant A
- WHEN un admin de A hace `PATCH` para marcarlo cargado, pide su archivo o reenvía su mail
- THEN responde 404
- AND la fila no cambia

## MODIFIED Requirements

### Requirement: `TenantConfig.receiptsEmail` [A]

`TenantConfig` MUST exponer `receiptsEmail: string`, leído de `tenants.receipts_email` en `getTenantByIdFromDb`, y `""` en el fallback por env (`buildTenantConfig`).

(Previamente: `TenantConfig` no tenía destino para comprobantes; `resend_from` y `legal_email` son otros conceptos y MUST NOT reutilizarse.)

**Precondición de despliegue (normativa)**: como `getTenantByIdFromDb` selecciona columnas por nombre, `0023` MUST estar aplicada en prod **antes** de mergear A; de lo contrario se cae portal y admin de todos los tenants.

#### Scenario: Tenant sin destino configurado

- GIVEN un tenant con `receipts_email = ''`
- WHEN se carga su `TenantConfig`
- THEN `receiptsEmail === ""`

#### Scenario: Fallback por env

- GIVEN la resolución de tenant por env (sin fila en DB)
- WHEN se arma el `TenantConfig`
- THEN `receiptsEmail === ""` y no falla

---

# receipts-storage Specification

## Purpose

Guardar los archivos en R2 (bucket del portal) sin que los bytes pasen por funciones ni proxy, con keys sin PII y aislamiento por tenant.

## Requirements

### Requirement: Los bytes nunca transitan una función ni el proxy [A]

Ningún endpoint del cambio MUST aceptar el archivo como body (multipart, base64, stream ni chunks) ni devolver los bytes del archivo como body de respuesta. Específicamente:
- la subida MUST ser un `PUT` del navegador directo a R2 con URL prefirmada;
- ver/descargar el archivo desde admin MUST responder **302** a una URL firmada de R2 generada en ese momento;
- los endpoints de init y confirm MUST recibir solo JSON de metadatos (del orden de KB).

Esto aplica también a cualquier "mejora" dentro de este cambio (proxy de bytes "para archivos chicos", fallback multipart, etc.): MUST NOT existir.

#### Scenario: Archivo de ~18 MB en un preview de Vercel

- GIVEN un preview de Vercel con R2 configurado y un cliente logueado
- WHEN sube un PDF de ~18 MB y confirma
- THEN el flujo termina 200 sin 413 ni truncado
- AND el objeto final en R2 tiene exactamente el tamaño y el sha256 del archivo original
- AND ningún request a `/api/**` durante el flujo tuvo un body mayor a unos pocos KB

#### Scenario: Ver un archivo de ~18 MB desde admin

- GIVEN el comprobante del escenario anterior
- WHEN un admin hace click en "Ver archivo"
- THEN `GET /api/admin/comprobantes/{id}/file` responde 302 con `Location` a R2
- AND el body de esa respuesta no contiene los bytes del archivo

#### Scenario: Revisión estática

- GIVEN el diff del cambio
- WHEN se buscan `formData()`, `request.arrayBuffer()`/`blob()` o respuestas con el cuerpo del objeto en las rutas nuevas
- THEN no hay ninguna que reciba o devuelva el archivo

### Requirement: Configuración "las 4 o ninguna" y degradación [A]

El storage MUST considerarse configurado solo si están presentes `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`. Si falta cualquiera:
- init, confirm, archivo admin y reenvío MUST responder **503** con mensaje claro ("La recepción de comprobantes no está disponible");
- el resto del portal y del admin MUST funcionar normalmente (sin crash, sin 500 en otras páginas);
- el portal SHOULD ocultar el botón "Informar pago".

#### Scenario: Falta una variable

- GIVEN `R2_BUCKET` ausente
- WHEN el cliente llama a `POST /api/portal/comprobantes`
- THEN responde 503
- AND no se crea ninguna fila
- AND `GET /api/portal/pagos` sigue respondiendo 200

### Requirement: Layout de keys sin PII [A]

Las keys MUST decidirse en el servidor y seguir exactamente:
- temporal (destino del PUT): `tmp/receipts/{tenantId}/{receiptId}`;
- final: `receipts/{tenantId}/{yyyy-mm}/{receiptId}.{ext}` con `ext` derivada del mime sniffeado/convertido.

Las keys MUST NOT contener nombre original, `codigocliente`, razón social, CUIT ni email. Todo endpoint que opere un objeto MUST tomar la key de la fila en DB, nunca de parámetros del request.

#### Scenario: Nombre de archivo con datos del cliente

- GIVEN un cliente que sube `Pago ACME SA 20-12345678-9.pdf`
- WHEN el comprobante queda `pending`
- THEN `file_key` coincide con `receipts/{tenantId}/{yyyy-mm}/{uuid}.pdf`
- AND no contiene ninguna parte del nombre original

#### Scenario: Key inyectada por el request

- GIVEN un request de confirm o de archivo admin con un parámetro `key=receipts/otro-tenant/...`
- WHEN se procesa
- THEN el parámetro se ignora y se usa solo la key de la fila del tenant/cliente autorizado

### Requirement: URL de subida prefirmada acotada [A]

La URL PUT MUST:
- tener TTL entre 5 y 10 minutos;
- firmar `content-type` y `content-length` con los valores declarados en el init, de modo que R2 rechace un PUT con otro tamaño o tipo;
- apuntar solo a la key temporal de ese comprobante.

#### Scenario: PUT con tamaño distinto al firmado

- GIVEN una URL firmada para `content-length = 1000000`
- WHEN el navegador hace PUT de 1500000 bytes
- THEN R2 rechaza el PUT (403/400)
- AND el objeto temporal no existe

#### Scenario: URL vencida

- GIVEN una URL firmada hace más de su TTL
- WHEN se hace el PUT
- THEN R2 lo rechaza

### Requirement: URL firmada de lectura corta, generada al click [A]

`GET /api/admin/comprobantes/{id}/file` MUST generar la URL firmada en ese request (nunca en el listado), con TTL ≤ 10 minutos, `response-content-type` = `file_mime` de la fila y `response-content-disposition` con nombre generado `comprobante-{paid_on}-{id8}.{ext}` (nunca el nombre original). La respuesta 302 MUST llevar `Cache-Control: private, no-store`.

#### Scenario: Nombre de descarga controlado

- GIVEN un comprobante con `file_original_name = "<script>.pdf"`, `paid_on = 2026-09-01`, `file_mime = application/pdf`
- WHEN se pide el archivo
- THEN la URL firmada fuerza `Content-Type: application/pdf` y `filename="comprobante-2026-09-01-xxxxxxxx.pdf"`

#### Scenario: El listado no expone URLs firmadas

- GIVEN la respuesta de `GET /api/admin/comprobantes`
- WHEN se inspecciona el JSON
- THEN no contiene ninguna URL de R2 ni firma

### Requirement: Configuración del bucket (operativa, bloqueante para prod) [A]

Antes de habilitar la feature en prod MUST cumplirse, y MUST quedar documentado en `docs/DEPLOY.md`:
- token de R2 con alcance **solo** al bucket del portal (Object Read & Write), distinto del actual;
- CORS del bucket que permita `PUT` solo desde los orígenes del portal (subdominios de la plataforma + dominios propios de tenants), header `content-type`; MUST NOT usar `*`;
- lifecycle que borre el prefijo `tmp/` a 1 día;
- el prefijo `receipts/` sin expiración.

#### Scenario: Origen no permitido

- GIVEN CORS configurado para los orígenes del portal
- WHEN una página de un origen ajeno intenta el PUT con una URL válida
- THEN el navegador bloquea la subida por CORS

#### Scenario: Token re-scopeado

- GIVEN las credenciales cargadas en Vercel para la feature
- WHEN se intenta listar otro bucket (p. ej. el de adjuntos de WhatsApp)
- THEN R2 lo rechaza

---

# receipt-file-validation Specification

## Purpose

Aceptar solo comprobantes legítimos (PDF e imágenes), con tope de tamaño y tipo real verificado, y neutralizar contenido peligroso o metadatos sensibles.

## Requirements

### Requirement: Tope de 20 MB verificado en tres puntos [A]

El tamaño máximo MUST ser 20 MB (20 × 1024 × 1024 = 20971520 bytes) y MUST verificarse:
1. en el navegador antes de subir (UX, no seguridad);
2. en el init sobre `fileSize` declarado: `0 < fileSize ≤ 20 MB`; si lo supera → **413**, si es ≤ 0 o no numérico → **400**; en ambos casos sin crear fila;
3. en el confirm sobre el tamaño **real** del objeto (HEAD): si supera 20 MB o difiere del declarado, MUST borrar el objeto temporal y responder **413**, sin pasar a `pending`.

#### Scenario: Archivo de 25 MB en el navegador

- GIVEN el modal "Informar pago"
- WHEN el cliente elige un archivo de 25 MB
- THEN el modal muestra "El archivo supera 20 MB" y no llama al init

#### Scenario: Init con más de 20 MB declarado

- GIVEN un cliente logueado
- WHEN `POST /api/portal/comprobantes` con `fileSize = 22020096`
- THEN responde 413
- AND no se crea fila ni URL

#### Scenario: Exactamente 20 MB

- GIVEN `fileSize = 20971520`
- WHEN se hace el init
- THEN responde 200 con URL de subida

#### Scenario: Objeto real mayor al permitido en el confirm

- GIVEN una fila `uploading` y un objeto temporal de 21 MB (p. ej. subido por fuera del flujo firmado)
- WHEN se llama al confirm
- THEN responde 413
- AND el objeto temporal se borra
- AND la fila no pasa a `pending` y no se manda mail

### Requirement: Tipo real por magic bytes y allowlist [A]

El confirm MUST leer los primeros bytes del objeto y clasificarlo solo por firma:
- PDF `25 50 44 46 2D` (`%PDF-`);
- JPEG `FF D8 FF`;
- PNG `89 50 4E 47 0D 0A 1A 0A`;
- WebP `RIFF` + 4 bytes + `WEBP`;
- HEIC/HEIF: caja `ftyp` con brand ∈ {`heic`,`heix`,`hevc`,`heim`,`heis`,`mif1`,`msf1`} (ver requisitos HEIC).

Cualquier otro contenido (SVG, HTML, XML, texto, ejecutables, ZIP, vacío) MUST rechazarse con **415**, borrando el objeto temporal, sin fila `pending`, sin objeto en `receipts/` y sin mail.

`file_mime` MUST ser siempre el tipo sniffeado (o el resultante de la conversión), nunca el declarado. Si el tipo declarado difiere del sniffeado pero el sniffeado está en la allowlist, el comprobante MUST aceptarse con el tipo sniffeado.

El init MUST validar que el `contentType` declarado ∈ {pdf, jpeg, png, webp, heic, heif}; otro valor → 415 sin crear fila. (El declarado solo sirve para firmar el PUT; no otorga confianza.)

#### Scenario: SVG disfrazado de PNG

- GIVEN un init con `contentType = image/png` y un objeto temporal cuyo contenido es `<svg ...>`
- WHEN se llama al confirm
- THEN responde 415
- AND el objeto temporal se borra
- AND no existe objeto en `receipts/` ni fila `pending`

#### Scenario: HTML con extensión .pdf

- GIVEN un archivo `comprobante.pdf` cuyo contenido empieza con `<!DOCTYPE html>`, declarado `application/pdf`
- WHEN se confirma
- THEN responde 415

#### Scenario: Declarado PDF, bytes JPEG (mismatch dentro de la allowlist)

- GIVEN un init con `contentType = application/pdf` y un objeto que empieza con `FF D8 FF`
- WHEN se confirma
- THEN responde 200
- AND `file_mime = image/jpeg` y la key final termina en `.jpg`

#### Scenario: Tipo declarado fuera de la allowlist

- GIVEN un init con `contentType = image/svg+xml`
- THEN responde 415 sin crear fila

#### Scenario: PDF se guarda tal cual

- GIVEN un PDF válido
- WHEN se confirma
- THEN el objeto final es byte a byte igual al subido
- AND el servidor no parsea ni renderiza el PDF

### Requirement: Hash del archivo subido [A]

El confirm MUST calcular `file_sha256` sobre los bytes **tal como los subió el cliente** (objeto temporal, antes de cualquier conversión o strip) y guardarlo en la fila.

#### Scenario: Hash estable ante conversión

- GIVEN el mismo archivo subido dos veces
- WHEN ambos se confirman (con o sin conversión en C)
- THEN ambos tienen el mismo `file_sha256`

### Requirement: Nombre original saneado e informativo [A]

`file_original_name` MUST guardarse saneado: normalización NFKD, sin diacríticos, sin caracteres de control (incluido el carácter NUL, U+0000) ni separadores de ruta (`/ \ : * ? " < > |`), colapsado a `[A-Za-z0-9_.-]`, ≤ 80 caracteres, con la extensión re-derivada del mime real. Es solo informativo: MUST NOT usarse en keys, headers de descarga ni asunto del mail sin escape.

#### Scenario: Nombre hostil

- GIVEN el nombre `../../Pagó <b>junio</b>.PNG.exe` con un carácter NUL (U+0000) intercalado, y bytes JPEG
- WHEN se sanea
- THEN el resultado no contiene `/`, `\`, `<`, `>`, NUL ni `..` como segmento, mide ≤ 80 y termina en `.jpg`

### Requirement: HEIC/HEIF rechazado con mensaje claro [A]

> Vigente en A. Se **reemplaza** por "HEIC/HEIF convertido a JPG [C]" cuando C se mergea, o en A si el usuario pide adelantarlo.

- El `<input>` del modal MUST usar `accept="image/jpeg,image/png,application/pdf"` (hace que iOS convierta la mayoría de las fotos a JPEG).
- Un init con `contentType` `image/heic`/`image/heif` MUST responder **415** con el mensaje "Las fotos HEIC todavía no se aceptan: convertila a JPG o subí un PDF", sin crear fila.
- Un objeto cuyo sniff dé HEIC/HEIF (aunque se haya declarado otro tipo) MUST rechazarse en el confirm con el mismo 415 y mensaje, borrando el temporal.

#### Scenario: HEIC declarado

- GIVEN entrega A sin C
- WHEN init con `contentType = image/heic`
- THEN 415 con el mensaje de HEIC y sin fila

#### Scenario: HEIC disfrazado de JPEG

- GIVEN entrega A sin C, init con `image/jpeg` y objeto con `ftyp heic`
- WHEN se confirma
- THEN 415 con el mensaje de HEIC, objeto temporal borrado, sin `pending`

### Requirement: HEIC/HEIF convertido a JPG [C]

> Reemplaza "HEIC/HEIF rechazado [A]". Autocontenido: solo se apoya en "Strip de EXIF en imágenes".

Cuando el sniff dé HEIC/HEIF, el confirm MUST:
1. leer las dimensiones **antes** de decodificar y rechazar con **415** ("La imagen es demasiado grande") si superan 50 megapíxeles, borrando el temporal;
2. convertir a JPEG redimensionando a ancho máximo 2560 px sin agrandar, calidad ~82;
3. guardar `file_mime = image/jpeg`, extensión `.jpg`, `converted_from = image/heic` (o `image/heif`), `file_size` = tamaño del JPEG;
4. terminar dentro del `maxDuration` de la ruta (60 s).

El archivo final MUST NOT conservar metadatos EXIF/GPS. Si la conversión falla, MUST responder **422** ("No pudimos procesar la imagen") borrando el temporal, sin `pending`.

Al adelantarse a A, el `accept` del modal MAY seguir siendo el mismo (la conversión cubre los HEIC que llegan desde Mac/Files/AirDrop).

Criterio de aceptación para mergear C (verificación manual en preview, no CI): 3–4 HEIC reales de iPhone (12 y 48 MP) y 2–3 conversiones concurrentes dentro de `maxDuration` y con memoria pico aceptable. Si no se cumple, C MUST NOT mergearse y rige el requisito de A.

#### Scenario: HEIC de 12 MP

- GIVEN un HEIC de 4032×3024
- WHEN se confirma
- THEN 200, `file_mime = image/jpeg`, `converted_from = image/heic`, ancho final 2560

#### Scenario: Bomba de descompresión

- GIVEN un HEIF que declara 20000×20000
- WHEN se confirma
- THEN 415 sin decodificar los píxeles, temporal borrado

#### Scenario: HEIC corrupto

- GIVEN bytes con `ftyp heic` pero datos inválidos
- WHEN se confirma
- THEN 422, sin `pending`, temporal borrado

### Requirement: Strip de EXIF en imágenes [C]

Para JPEG y PNG (y WebP SHOULD), el archivo final MUST quedar sin EXIF/GPS, con la orientación ya aplicada a los píxeles. Las imágenes que no son HEIC MAY redimensionarse a 2560 px de ancho; si se hace, MUST ser sin agrandar. Los PDF MUST NOT modificarse.

#### Scenario: Foto con GPS

- GIVEN un JPEG con EXIF GPS y orientación 6
- WHEN se confirma
- THEN el objeto final no tiene EXIF
- AND se ve derecho

---

# portal-receipt-submission Specification

## Purpose

Que el cliente logueado informe un pago (archivo + monto + fecha + medio) desde Pagos, de forma segura, idempotente y sin que el archivo pase por funciones.

## Requirements

### Requirement: Botón y modal "Informar pago" [A]

En la sección Pagos del portal, el `Toolbar` de `PagosTable` MUST mostrar el botón **"Informar pago"** en el slot `extraActions` (solo con storage configurado). El modal MUST pedir:
- archivo (uno solo) con el `accept` del requisito HEIC vigente;
- **monto** (ARS, > 0, hasta 2 decimales);
- **fecha del pago** (no futura);
- **medio**: Transferencia / Cheque / Efectivo / Otro; si es Otro, un detalle obligatorio;
- **notas** opcionales.

El modal MUST NOT pedir selección de facturas. MUST mostrar progreso de subida, deshabilitar el envío mientras sube, y al terminar mostrar "Recibimos tu comprobante" aunque el mail a la empresa haya fallado.

#### Scenario: Happy path

- GIVEN un cliente logueado del tenant A y storage configurado
- WHEN abre "Informar pago", elige un PDF de 2 MB, carga monto 150000,50, fecha de ayer, medio Transferencia y envía
- THEN se llama al init, se hace el PUT a R2 con progreso, se llama al confirm
- AND el modal muestra "Recibimos tu comprobante"
- AND existe una fila `pending` del tenant A con su `codigocliente`, `amount = 150000.50`, `method = transferencia`
- AND el objeto final existe en `receipts/A/{yyyy-mm}/{id}.pdf` y no queda objeto en `tmp/`
- AND se envió el mail a la empresa (`email_status = sent`)

#### Scenario: Error de red en el PUT

- GIVEN el PUT a R2 falla
- WHEN el cliente está en el modal
- THEN ve un error recuperable ("No se pudo subir el archivo, probá de nuevo") y no se muestra éxito
- AND no se llama al confirm

### Requirement: Init del comprobante [A]

`POST /api/portal/comprobantes` MUST:
1. exigir sesión portal con `isLoggedIn && codigocliente`; si no, **401**;
2. aplicar rate limit (ver requisito);
3. validar metadatos: `amount` > 0, ≤ 999999999999.99, máx. 2 decimales; `paidOn` fecha válida no futura en `America/Argentina/Buenos_Aires`; `method` ∈ allowlist; `methodOther` obligatorio (1–80 chars) si `method = otro` e ignorado si no; `notes` opcional ≤ 500 chars; `fileName` ≤ 255; `fileSize` y `contentType` según `receipt-file-validation`. Inválido → **400** con errores por campo, sin crear fila;
4. tomar `tenant_id` del host y `codigocliente`, `razonsocial`, `cuit` **de la sesión**; cualquiera de esos campos en el body MUST ignorarse;
5. crear la fila `uploading` y responder `{ id, uploadUrl, headers }`.

La respuesta MUST llevar `Cache-Control: private, no-store`.

#### Scenario: Sin sesión

- GIVEN ninguna cookie de portal
- WHEN `POST /api/portal/comprobantes`
- THEN 401 y sin fila

#### Scenario: `codigocliente` en el body

- GIVEN la sesión del cliente X
- WHEN el body incluye `codigocliente: "Y"` y `razonsocial: "Otra"`
- THEN la fila creada tiene `codigocliente = X` y la razón social de la sesión

#### Scenario: Fecha futura

- WHEN `paidOn` es mañana (hora Argentina)
- THEN 400 con error en `paidOn`

#### Scenario: Medio "otro" sin detalle

- WHEN `method = otro` y `methodOther` vacío
- THEN 400 con error en `methodOther`

### Requirement: Confirm del comprobante [A]

`POST /api/portal/comprobantes/{id}/confirm` MUST:
1. exigir sesión portal (401 si no);
2. buscar la fila por `id` **AND** `tenant_id` del host **AND** `codigocliente` de la sesión; si no existe → **404**;
3. si la fila está `uploading`: verificar existencia y tamaño del objeto temporal (si no existe → **409** "No recibimos el archivo", la fila sigue `uploading`), aplicar `receipt-file-validation`, escribir el objeto final, borrar el temporal y pasar a `pending` con `submitted_at`, `file_key`, `file_mime`, `file_size`, `file_original_name`, `file_sha256`;
4. enviar el mail **antes de responder** (ver `receipt-notification-email`, parte 2);
5. responder 200 con `{ id, status: "pending" }` independientemente del resultado del mail.

La ruta MUST correr en runtime Node con `maxDuration = 60`.

#### Scenario: Confirm sin PUT previo

- GIVEN una fila `uploading` sin objeto temporal
- WHEN se confirma
- THEN 409 y la fila sigue `uploading`, sin mail

### Requirement: Confirm idempotente [A]

Si la fila ya está `pending` o `loaded`, el confirm MUST responder 200 con el estado actual **sin** reprocesar el archivo, sin reescribir objetos y **sin** reenviar el mail. Ante confirms concurrentes sobre la misma fila `uploading`, exactamente uno MUST realizar la transición y el envío de mail; los demás MUST responder 200 (o 409 transitorio) sin duplicar mail ni objeto.

#### Scenario: Confirm llamado dos veces

- GIVEN un comprobante que ya pasó a `pending` con `email_status = sent`
- WHEN el cliente vuelve a llamar al confirm (reintento, doble click)
- THEN 200 con `status = pending`
- AND el proveedor de mail recibió exactamente 1 envío para ese comprobante
- AND `submitted_at` no cambia

#### Scenario: Dos confirms simultáneos

- GIVEN una fila `uploading` con objeto temporal válido
- WHEN llegan dos confirms en paralelo
- THEN la fila termina `pending` una sola vez
- AND hay exactamente 1 envío de mail

### Requirement: Huérfanos de subidas abandonadas [A]

Si el cliente obtiene URL y (haga o no el PUT) nunca llama al confirm:
- la fila `uploading` MUST NOT aparecer en admin ni en el historial del portal, ni generar mail;
- el objeto temporal MUST borrarse por la lifecycle de `tmp/` (≤ 1 día);
- las filas `uploading` con `created_at` > 24 h MUST eliminarse (limpieza lazy en el init o por cron); la limpieza MUST limitarse a filas `uploading` y MUST NOT tocar `pending`/`loaded` ni objetos de `receipts/`;
- las filas `uploading` MUST NOT contar para rate limit diario ni para duplicados.

#### Scenario: PUT hecho, confirm nunca llamado

- GIVEN un cliente que hizo init + PUT exitoso y cerró la pestaña
- WHEN un admin abre "Comprobantes recibidos"
- THEN ese comprobante no aparece
- AND no se envió mail
- AND pasadas 24 h la fila ya no existe tras la siguiente limpieza

#### Scenario: La limpieza no toca comprobantes válidos

- GIVEN un comprobante `pending` creado hace 3 días
- WHEN corre la limpieza
- THEN la fila y su objeto final siguen existiendo

### Requirement: Rate limit de informes [A]

`POST /api/portal/comprobantes` MUST limitar por `${tenantId}:${codigocliente}`:
- ventana por proceso (patrón `send-code`), default 10 inits por hora → **429**;
- tope diario en DB (filas no-`uploading` del cliente en 24 h), default 20 → **429**, efectivo aunque haya varias instancias.

Los valores MUST ser constantes con nombre. Un cliente MUST NOT consumir la cuota de otro cliente ni de otro tenant.

#### Scenario: Tope por hora

- GIVEN 10 inits del cliente X en la última hora en la misma instancia
- WHEN hace el 11º
- THEN 429 y sin fila

#### Scenario: Tope diario entre instancias

- GIVEN 20 comprobantes `pending` del cliente X en las últimas 24 h
- WHEN hace un init (en cualquier instancia)
- THEN 429

#### Scenario: Cuotas separadas

- GIVEN el cliente X bloqueado
- WHEN el cliente Y del mismo tenant hace un init
- THEN 200

### Requirement: Aislamiento del portal [A]

Todas las consultas del portal sobre `payment_receipts` MUST filtrar por `tenant_id` del host **AND** `codigocliente` de la sesión. Un id de otro cliente o de otro tenant MUST responder **404** con el mismo cuerpo que un id inexistente, sin cambiar estado. El portal MUST NOT exponer ninguna ruta que devuelva el archivo ni URLs firmadas de lectura.

#### Scenario: Cliente confirma el comprobante de otro cliente

- GIVEN una fila `uploading` del cliente Y
- WHEN el cliente X llama al confirm con ese id
- THEN 404 idéntico al de un uuid inexistente
- AND la fila de Y no cambia y no se manda mail

#### Scenario: Mismo `codigocliente` en otro tenant

- GIVEN un comprobante del tenant B con `codigocliente = 123`
- WHEN un cliente con `codigocliente = 123` logueado en el host del tenant A llama al confirm con ese id
- THEN 404

---

# portal-receipt-history Specification

## Purpose

Que el cliente vea en Pagos lo que ya informó y su estado, para no mandarlo dos veces.

## Requirements

### Requirement: Listado de comprobantes informados [B]

`GET /api/portal/comprobantes` MUST devolver solo los comprobantes del `tenant_id` del host y `codigocliente` de la sesión, excluyendo `uploading`, ordenados por `submitted_at` descendente, con `Cache-Control: private, no-store`. Cada ítem MUST incluir solo: `id`, `submittedAt`, `paidOn`, `amount`, `currency`, `method` (+ `methodOther`), `status` (`pending`/`loaded`). MUST NOT incluir `loaded_by`, `loaded_by_name`, `email_status`, `email_error`, `file_key`, `file_sha256` ni URLs. Sin sesión → 401.

El área Pagos MUST mostrar ese listado con estados "Pendiente" y "Cargado", y MUST refrescarlo tras informar un pago. MUST NOT haber acceso al archivo desde el portal.

#### Scenario: Cliente ve lo suyo

- GIVEN el cliente X con 2 comprobantes `pending`, 1 `loaded` y 1 `uploading`
- WHEN abre Pagos
- THEN ve 3 ítems (2 Pendiente, 1 Cargado)

#### Scenario: Cliente no ve los de otro

- GIVEN comprobantes del cliente Y (mismo tenant) y de un cliente con el mismo `codigocliente` en otro tenant
- WHEN X pide `GET /api/portal/comprobantes`
- THEN la respuesta no contiene ninguno de ellos

#### Scenario: No se filtra quién cargó

- GIVEN un comprobante `loaded` por "Ana"
- WHEN el cliente lista
- THEN el JSON no contiene "Ana" ni ids de `admin_users`

### Requirement: Aviso de duplicado por sha256 (avisa, no bloquea) [B]

Al confirmar, si existe otro comprobante no-`uploading` del mismo `tenant_id` + `codigocliente` con igual `file_sha256`, el confirm MUST igual pasar a `pending` y mandar el mail, y MUST incluir `duplicateOf: { id, submittedAt }` en la respuesta; el modal MUST mostrar "Parece que ya nos enviaste este archivo el {fecha}". El mail a la empresa SHOULD indicar "Posible duplicado de un comprobante del {fecha}". Coincidencias con otros clientes u otros tenants MUST NOT informarse.

(En A el `file_sha256` ya se calcula y guarda; B solo agrega la consulta y el aviso.)

#### Scenario: Mismo archivo dos veces

- GIVEN un comprobante `pending` del cliente X con sha256 H
- WHEN X informa otro pago con el mismo archivo
- THEN el nuevo comprobante queda `pending` y se manda mail
- AND la respuesta incluye `duplicateOf` con el id anterior
- AND el modal muestra el aviso

#### Scenario: Mismo archivo, otro cliente

- GIVEN un comprobante del cliente Y con sha256 H
- WHEN X sube un archivo con sha256 H
- THEN la respuesta no incluye `duplicateOf`

(Continúa en `sdd/comprobantes-de-pago/spec-part-2`.)

---

<!-- parte 2 (guardada separada en engram por límite de 50k) -->

# Spec: comprobantes-de-pago (PARTE 2 de 2)

Continuación de `sdd/comprobantes-de-pago/spec` (parte 1: invariantes, etiquetas de entrega [A]/[B]/[C], data-model, storage, file-validation, portal-submission, portal-history). Los invariantes rectores de la parte 1 rigen también acá.

---

# receipt-notification-email Specification

## Purpose

Avisar a la empresa por mail cada comprobante recibido, desde el remitente de plataforma, sin que un fallo del mail pierda el comprobante.

## MODIFIED Requirements

### Requirement: `sendEmail` con opciones compatibles hacia atrás [A]

`sendEmail(tenant, to, subject, html, text?, options?)` MUST aceptar un objeto opcional final `{ attachments?, from?, replyTo?, tags? }`. Sin `options`, el comportamiento MUST ser idéntico al actual (`from = tenant.resendFrom`, sin adjuntos, dry-run sin `RESEND_API_KEY`, lanza si Resend rechaza).

(Previamente: `sendEmail(tenant, to, subject, html, text?)` con `from` fijo en `tenant.resendFrom` y sin adjuntos/replyTo/tags.)

#### Scenario: Llamadores existentes sin cambios

- GIVEN el mail de OTP del portal
- WHEN se envía después del cambio
- THEN sale con `from = tenant.resendFrom`, sin adjuntos ni replyTo, igual que antes

## ADDED Requirements

### Requirement: Contenido y remitente del mail de comprobante [A]

Al pasar un comprobante a `pending`, el sistema MUST enviar un mail con:
- **from**: dirección de plataforma leída de `RECEIPTS_EMAIL_FROM` (MUST NOT estar hardcodeada en el código), con display name `"{tenant.name} · Comprobantes"`; MUST NOT caer a `tenant.resendFrom`;
- **to**: `tenant.receiptsEmail` (un único destinatario);
- **replyTo**: email de la sesión del cliente si existe; si no, sin replyTo;
- **subject**: `[Comprobante de pago] {razonsocial} — ${monto} — {dd/mm/aaaa}` (monto formateado ARS, fecha = `paid_on`), sin CR/LF ni caracteres de control, con el prefijo fijo exacto `[Comprobante de pago]`;
- **cuerpo** (HTML + texto): razón social, CUIT, monto, fecha del pago, medio (+ detalle), notas, fecha de recepción y un link absoluto a `/admin/comprobantes?id={id}` sobre el host del tenant. Todo dato proveniente del cliente MUST ir escapado. El link MUST NOT ser una URL firmada de R2;
- **tags**: `type=payment_receipt` y `tenant={tenantId}`.

#### Scenario: Inyección en razón social y notas

- GIVEN `razonsocial = "ACME <img src=x onerror=alert(1)>"` y `notes = "</p><script>x</script>"`
- WHEN se arma el mail
- THEN el HTML contiene esos textos escapados (`&lt;img`, `&lt;script&gt;`) y ninguna etiqueta activa

#### Scenario: Header injection en el subject

- GIVEN una `razonsocial` que contiene un salto de línea CR/LF seguido de `Bcc: otro@ejemplo.com`
- WHEN se arma el subject
- THEN no contiene CR ni LF y empieza con `[Comprobante de pago] `

#### Scenario: Cliente sin email en la sesión

- GIVEN una sesión con `email` vacío
- WHEN se envía el mail
- THEN no lleva replyTo y se envía igual

#### Scenario: Remitente de plataforma con nombre del tenant

- GIVEN `RECEIPTS_EMAIL_FROM` configurada y un tenant llamado "Empresa Demo"
- WHEN se envía el mail
- THEN el `from` es `"Empresa Demo · Comprobantes" <valor de RECEIPTS_EMAIL_FROM>`
- AND no usa `tenant.resendFrom`

### Requirement: Adjuntar hasta 10 MB, link por encima [A]

Si el archivo final pesa ≤ 10 MB (10485760 bytes), el mail MUST adjuntarlo con nombre `comprobante-{paid_on}-{id8}.{ext}` y el mime real. Si pesa más, MUST enviarse sin adjunto, con el aviso "El archivo pesa X MB: velo en el backoffice" y el link al admin.

#### Scenario: PDF de 3 MB

- WHEN se confirma
- THEN el mail lleva 1 adjunto `application/pdf`

#### Scenario: PDF de 15 MB

- WHEN se confirma
- THEN el mail no lleva adjunto, e incluye el aviso con el tamaño y el link

#### Scenario: Exactamente 10 MB

- WHEN el archivo final pesa 10485760 bytes
- THEN se adjunta

### Requirement: Estado del mail y fallo sin pérdida [A]

El resultado del envío MUST registrarse en la fila:
- éxito → `email_status = sent`, `email_sent_at`;
- el proveedor rechaza o hay error de red → `email_status = failed`, `email_error` (mensaje acotado, ≤ 500 chars, sin secretos);
- falta `RESEND_API_KEY`, `RECEIPTS_EMAIL_FROM` o `tenant.receiptsEmail` → `email_status = skipped` con el motivo en `email_error`, sin intentar enviar.

Un fallo o skip del mail MUST NOT revertir el comprobante (sigue `pending`, con archivo final) ni cambiar la respuesta al cliente (200).

#### Scenario: Proveedor de mail caído

- GIVEN Resend responde error
- WHEN el cliente confirma
- THEN el cliente recibe 200 y ve "Recibimos tu comprobante"
- AND la fila queda `pending` con `email_status = failed` y `email_error` no vacío
- AND el objeto final existe

#### Scenario: Tenant sin destino

- GIVEN `tenant.receiptsEmail = ""`
- WHEN el cliente confirma
- THEN la fila queda `pending` con `email_status = skipped`
- AND no se llamó al proveedor

### Requirement: Reenviar mail [A]

`POST /api/admin/comprobantes/{id}/resend-email` (admin+, guard de `admin-receipts`) MUST reenviar el mail del comprobante con las mismas reglas de contenido y adjunto, releyendo el archivo final desde R2, y actualizar `email_status`/`email_sent_at`/`email_error`. MUST estar permitido para `failed` y `skipped`, y SHOULD permitirse para `sent` (reenvío explícito). Si falta configuración (destino, from o API key), MUST responder **409** con el motivo ("Configurá el mail destino en Configuración") y dejar `skipped`. Si el proveedor falla, MUST responder **502**, dejar `failed` y MUST NOT alterar `status`.

#### Scenario: Reenvío tras fallo

- GIVEN un comprobante `pending` con `email_status = failed`
- AND el proveedor ya responde bien
- WHEN un admin hace "Reenviar mail"
- THEN 200 y la fila pasa a `email_status = sent` con `email_sent_at`
- AND `status` sigue `pending`

#### Scenario: Reenvío con proveedor todavía caído

- WHEN un admin reenvía
- THEN 502, `email_status = failed`, `email_error` actualizado

#### Scenario: Reenvío sin destino

- GIVEN `receiptsEmail = ""`
- WHEN un admin reenvía
- THEN 409 con mensaje que apunta a Configuración

---

# admin-receipts Specification

## Purpose

Pantalla "Comprobantes recibidos" para que admin/superadmin vean los comprobantes de su tenant, abran el archivo, los marquen como cargados en Alegra y reenvíen el mail.

## ADDED Requirements

### Requirement: Guard obligatorio en toda ruta nueva [A]

Toda ruta nueva bajo `/api/admin/comprobantes/**` y `/api/admin/settings/receipts` MUST:
1. usar `getGuardedAdminSession(req)` (tenant del host + fila de `admin_users` + rol de DB); si rechaza → **401**;
2. exigir `roleRank(role) ≥ 1` con el rol de DB; si no → **404** con el mismo cuerpo que un recurso inexistente;
3. filtrar toda consulta/escritura por `tenant_id = <tenant del guard>` **AND** `id`; nunca por `id` solo.

MUST NOT leer `tenantId`/`role` crudos de la cookie (patrón del resto de `/api/admin/**`, que queda fuera de alcance).

#### Scenario: Rol degradado en DB con cookie vieja

- GIVEN una cookie emitida con `role = admin` y la fila hoy con `role = operator`
- WHEN llama a `GET /api/admin/comprobantes`
- THEN 404

#### Scenario: Sesión de otro tenant en este host

- GIVEN una sesión del tenant A usada bajo el host del tenant B
- WHEN llama a cualquier ruta nueva
- THEN 401 y ningún dato de A ni de B

### Requirement: Listado de comprobantes recibidos [A]

`GET /api/admin/comprobantes` MUST devolver comprobantes del tenant del guard, excluyendo `uploading`, con filtro `status ∈ {pending, loaded}` (default `pending`), paginado (≤ 50 por página), ordenado por `submitted_at` descendente. Cada ítem MUST incluir: fecha de recepción, razón social, CUIT, monto, fecha del pago, medio (+ detalle), notas, `status`, `email_status`, `loaded_at`, `loaded_by_name`, tamaño y tipo de archivo. La pantalla `/admin/comprobantes` MUST mostrar:
- badge "Mail no enviado" cuando `email_status ∈ {failed, skipped}`;
- aviso visible si `tenant.receiptsEmail` está vacío, con link a Configuración;
- acciones **Ver archivo**, **Marcar cargado en Alegra** / **Deshacer**, **Reenviar mail**.

Con `?id={id}` (link del mail) la pantalla SHOULD resaltar/abrir ese comprobante; si el id no es del tenant, MUST mostrarse como no encontrado sin revelar nada.

#### Scenario: Filtro por defecto

- GIVEN en el tenant A 3 `pending`, 2 `loaded` y 1 `uploading`
- WHEN un admin abre la pantalla
- THEN ve los 3 pendientes; al filtrar "Cargados" ve los 2; nunca ve el `uploading`

#### Scenario: Link del mail con id ajeno

- GIVEN un admin de A que abre `/admin/comprobantes?id=<id de B>`
- THEN la pantalla indica "Comprobante no encontrado" sin mostrar datos de B

### Requirement: Ver archivo [A]

`GET /api/admin/comprobantes/{id}/file` MUST responder según `receipts-storage` (302 a URL firmada generada al click, TTL ≤ 10 min). Si el comprobante no es del tenant, no existe o está `uploading` → 404. Si el objeto no existe en R2 → 404 con mensaje "Archivo no disponible". Sin storage configurado → 503.

#### Scenario: Archivo propio

- GIVEN un admin de A y un comprobante `pending` de A
- WHEN pide el archivo
- THEN 302 a una URL de R2 que vence en ≤ 10 min

### Requirement: Marcar cargado en Alegra / deshacer con auditoría [A]

`PATCH /api/admin/comprobantes/{id}` con `{ status: "loaded" | "pending" }` MUST:
- `pending → loaded`: grabar `status = loaded`, `loaded_at = now()`, `loaded_by = userId` del guard, `loaded_by_name` = nombre (o email) del admin leído de DB;
- `loaded → pending` (deshacer): grabar `status = pending` y limpiar `loaded_at`, `loaded_by`, `loaded_by_name`;
- en ambos casos, emitir un registro de auditoría estructurado en el log del servidor con `tenantId`, `receiptId`, transición, `userId` y timestamp (v1 no tiene tabla de eventos; ver riesgo en el envelope);
- ser idempotente: pedir el estado en el que ya está → 200 sin modificar `loaded_at`/`loaded_by` originales;
- rechazar cualquier otro valor de `status` con **400**;
- MUST NOT modificar ni borrar el archivo (el archivo final no se borra nunca en v1).

La acción de deshacer SHOULD pedir confirmación en la UI.

#### Scenario: Marcar cargado

- GIVEN un comprobante `pending` de A y la admin "Ana" de A
- WHEN hace "Marcar cargado en Alegra"
- THEN 200, `status = loaded`, `loaded_by = Ana.id`, `loaded_by_name = "Ana"`, `loaded_at` ≈ ahora
- AND el log registra la transición con el userId de Ana
- AND el objeto final sigue existiendo en R2

#### Scenario: Deshacer

- GIVEN ese comprobante `loaded` por Ana
- WHEN el superadmin "Beto" hace "Deshacer"
- THEN 200, `status = pending`, `loaded_*` en NULL
- AND el log registra `loaded → pending` con el userId de Beto

#### Scenario: Doble click en marcar

- GIVEN un comprobante ya `loaded` por Ana
- WHEN Beto envía `{ status: "loaded" }`
- THEN 200 y `loaded_by` sigue siendo Ana

#### Scenario: Estado inválido

- WHEN se envía `{ status: "uploading" }`
- THEN 400 y la fila no cambia

### Requirement: Aislamiento entre tenants en admin [A]

Un admin o superadmin del tenant A MUST NOT poder listar, ver archivo, marcar/deshacer ni reenviar comprobantes del tenant B. Todo id de otro tenant MUST responder **404** idéntico al de un uuid inexistente, sin efectos (sin URL firmada, sin mail, sin cambio de estado).

#### Scenario: Id de otro tenant

- GIVEN un superadmin del tenant A y un comprobante `pending` Q del tenant B
- WHEN llama a `PATCH /api/admin/comprobantes/Q`, `GET …/Q/file` y `POST …/Q/resend-email`
- THEN las tres responden 404 idéntico a un uuid inexistente
- AND Q sigue `pending`, sin mail enviado ni URL firmada generada

#### Scenario: Listado no mezcla tenants

- GIVEN comprobantes en A y en B
- WHEN un admin de A lista con cualquier filtro y página
- THEN ningún ítem es de B

## MODIFIED Requirements

### Requirement: Operator no ve la feature [A]

Para `role = operator` (rol leído de DB):
- la entrada "Comprobantes" (icono `Receipt`) del `AdminShell` MUST NOT mostrarse (`minRole: "admin"`);
- `/admin/comprobantes` MUST responder `notFound()` (404);
- `GET /api/admin/comprobantes`, `PATCH /api/admin/comprobantes/{id}`, `GET …/{id}/file`, `POST …/{id}/resend-email`, `GET`/`PUT /api/admin/settings/receipts` MUST responder **404** sin efectos secundarios;
- el tab "Comprobantes" de Configuración MUST NOT mostrarse.

(Previamente: `AdminShell.NAV` no tenía entrada de comprobantes; `ConfiguracionShell` tenía solo los tabs `catalogo` (superadmin) y `horarios` (admin+).)

#### Scenario: Operator intenta entrar

- GIVEN un operator logueado del tenant A y un comprobante `pending` de A con id P
- WHEN navega a `/admin/comprobantes` y llama a `PATCH /api/admin/comprobantes/P`, `GET /api/admin/comprobantes/P/file` y `POST /api/admin/comprobantes/P/resend-email`
- THEN todas responden 404 con cuerpo idéntico al de un id inexistente
- AND P sigue `pending`, no se generó URL firmada y no se envió mail
- AND la nav no muestra "Comprobantes"

#### Scenario: Admin y superadmin sí

- GIVEN un admin y un superadmin del tenant A
- WHEN abren `/admin/comprobantes`
- THEN ven la pantalla y la entrada en la nav

---

# tenant-receipts-settings Specification

## Purpose

Que un admin configure el único mail destino de comprobantes de su tenant.

## ADDED Requirements

### Requirement: Mail destino editable desde Configuración [A]

`/admin/configuracion` MUST tener un tab **"Comprobantes"** visible para admin+ con un campo "Email para comprobantes". `GET`/`PUT /api/admin/settings/receipts` (guard + admin+, operator → 404) MUST leer/escribir `tenants.receipts_email` **solo** del tenant del guard. El valor MUST:
- ser un único email válido (trim, ≤ 254 chars, sin comas, `;`, espacios internos ni CR/LF), o
- ser vacío (permitido: deja los mails en `skipped` y muestra aviso).

Inválido → **400** sin modificar. El `PUT` MUST NOT aceptar `tenantId` del body.

#### Scenario: Admin guarda el destino

- GIVEN un admin del tenant A
- WHEN `PUT` con `{ receiptsEmail: "pagos@ejemplo.com" }`
- THEN 200 y `tenants.receipts_email` de A = `pagos@ejemplo.com`
- AND el tenant B no cambia

#### Scenario: Varios destinatarios

- WHEN `PUT` con `"a@ejemplo.com, b@ejemplo.com"`
- THEN 400 ("Un solo email")

#### Scenario: Vaciar

- WHEN `PUT` con `""`
- THEN 200 y la pantalla de comprobantes muestra el aviso de destino no configurado

#### Scenario: `tenantId` en el body

- GIVEN un admin de A
- WHEN `PUT` con `{ receiptsEmail: "x@ejemplo.com", tenantId: "B" }`
- THEN se modifica solo A

#### Scenario: Operator

- WHEN un operator hace `GET` o `PUT`
- THEN 404 y no ve el tab

---

# receipts-tests-and-hygiene Specification

## Purpose

Que cualquier regresión de tamaño, tipo, aislamiento, roles o idempotencia rompa CI, y que el repo público no contenga datos reales.

## ADDED Requirements

### Requirement: Suite obligatoria [A/B/C]

MUST existir tests bajo el setup actual (`npm test` unit, `npm run test:integration` contra `crm_test` con la guarda anti-prod) con, al menos:

| # | Nivel | Entrega | Verifica |
|---|---|---|---|
| 1 | unit | A | Magic bytes: PDF/JPEG/PNG/WebP aceptados; SVG, HTML, texto, vacío → rechazo; SVG declarado `image/png` → rechazo; mismatch dentro de allowlist → tipo sniffeado |
| 2 | unit | A | HEIC sniffeado o declarado → rechazo con mensaje (se reemplaza por #17 si HEIC se adelanta) |
| 3 | unit | A | Saneo de nombre (NUL, `..`, separadores, HTML, largo, extensión re-derivada) |
| 4 | unit | A | Builder del mail: escape HTML, subject sin CR/LF con prefijo exacto, umbral 10 MB inclusivo, replyTo opcional, from de env con display name del tenant |
| 5 | unit | A | `r2.ts` con `fetch` mockeado: PUT firma `content-type` y `content-length`, TTL en rango; GET firmado con disposition/type |
| 6 | unit | A | Validación de metadatos (monto, fecha futura en hora AR, medio, `methodOther`, notas, 20 MB inclusivo) |
| 7 | unit | A | `sendEmail` sin options se comporta igual que antes |
| 8 | integración | A | Operator → 404 en página y en todas las rutas admin nuevas y `settings/receipts`; cookie con rol viejo → 404 |
| 9 | integración | A | Admin de A → 404 al archivo/marcar/reenviar comprobantes de B; listado sin mezcla |
| 10 | integración | A | Portal: cliente X no confirma (404) comprobantes de Y ni de otro tenant con igual `codigocliente`; body con `codigocliente` ajeno se ignora |
| 11 | integración | A | Confirm idempotente: 2 llamadas → 1 mail, `submitted_at` estable |
| 12 | integración | A | Fallo de mail → `pending` + `failed`; reenviar → `sent`; sin destino → `skipped` y 409 al reenviar |
| 13 | integración | A | Marcar/deshacer con `loaded_by`/`loaded_by_name` y limpieza; doble marcar no pisa `loaded_by` |
| 14 | integración | A | Filas `uploading` invisibles y limpiadas > 24 h sin tocar `pending` |
| 15 | integración | A | Rate limit diario en DB → 429; cuotas por cliente separadas |
| 16 | integración | A | `GET …/file` responde 302 con `Location` a R2 (nunca bytes) |
| 17 | integración | B | Historial solo propio, sin `uploading` ni datos del admin; `duplicateOf` solo mismo cliente/tenant |
| 18 | unit | C | Tope 50 MP antes de decodificar; conversión produce JPEG ≤ 2560 px sin EXIF; corrupto → 422 |

R2 y el proveedor de mail MUST mockearse en tests (sin credenciales reales en CI).

Verificación manual obligatoria (checklist de `sdd-verify`, no CI): PDF de 15–20 MB en preview de Vercel (sube, confirma, mail sin adjunto con link, admin abre por 302); archivo < 10 MB con adjunto; en C, medición de HEIC.

#### Scenario: La suite detecta proxy de bytes

- GIVEN la suite en verde
- WHEN alguien cambia `GET …/file` para devolver los bytes en vez de 302
- THEN falla el test 16

#### Scenario: La suite detecta el patrón de cookie cruda

- GIVEN la suite en verde
- WHEN una ruta nueva deja de usar el guard y lee `session.role`/`session.tenantId` de la cookie
- THEN falla el test 8 o el 9

### Requirement: Sin datos reales en el repo público [A/B/C]

Código, migración, tests, fixtures, seeds, docs y descripción de PR MUST NOT contener: el mail destino real de ningún tenant, la dirección remitente de plataforma, URLs de producción, nombres/CUIT/códigos de clientes reales ni credenciales. Los fixtures MUST usar dominios reservados (`ejemplo.com`/`example.com`) y datos inventados. La dirección remitente MUST venir de `RECEIPTS_EMAIL_FROM` y el destino de la DB.

#### Scenario: Revisión previa al merge

- GIVEN el diff de cada PR
- WHEN se buscan los dominios de tenants reales, direcciones de proveedores de mail personales y el dominio de la plataforma
- THEN no hay coincidencias fuera de nombres de variables de entorno

### Requirement: Documentación y orden de despliegue [A]

`docs/FUNCIONALIDADES.md` MUST describir la feature (quién informa, quién ve, estados, mail, límites 20 MB / 10 MB, HEIC según entrega). `docs/DEPLOY.md` MUST documentar: envs `R2_*` y `RECEIPTS_EMAIL_FROM` (Production y Preview + redeploy), token R2 re-scopeado, CORS (sin `*`; alta de tenant con dominio propio = actualizar CORS), lifecycle `tmp/` a 1 día, y el orden **migración 0023 en prod → merge**. El `.sql` y la descripción del PR A MUST repetir el aviso "APLICAR EN PROD ANTES DE MERGEAR".

#### Scenario: Docs presentes

- GIVEN el PR A
- WHEN se leen `docs/DEPLOY.md` y `docs/FUNCIONALIDADES.md`
- THEN contienen las secciones anteriores sin valores reales de prod

---

# Trazabilidad: Success Criteria del proposal → requisitos

| Success criterion | Requisito |
|---|---|
| PDF ~18 MB en preview sin 413, tamaño y sha256 iguales | storage / Bytes nunca transitan; validation / PDF tal cual |
| SVG/HTML como `image/png` → 415 sin `pending` ni objeto final | validation / Magic bytes |
| PUT con otro tamaño rechazado; > 20 MB borrado con 413 | storage / URL prefirmada; validation / Tope 20 MB |
| Mail con remitente de plataforma, display name, prefijo, replyTo, adjunto ≤ 10 MB | email / Contenido; Adjuntar hasta 10 MB |
| Resend caído → éxito al cliente, `failed`, Reenviar → `sent` | email / Estado del mail; Reenviar |
| Admin/superadmin ven, abren (302), marcan/deshacen con auditoría | admin / Listado; Ver archivo; Marcar/deshacer |
| Operator sin nav y 404 en todo | admin / Operator no ve la feature |
| Admin A → 404 sobre B | admin / Aislamiento entre tenants |
| Cliente ve sus comprobantes, nunca los de otro | history / Listado [B]; submission / Aislamiento del portal |
| HEIC convertido o rechazado con mensaje | validation / HEIC [A] y [C] |
| Mail destino desde Configuración, vacío = skipped | settings / Mail destino; email / Estado del mail |
| lint + unit + integración en verde | tests / Suite obligatoria |
| 0023 antes del merge; sin datos reales | data-model / 0023 y TenantConfig; tests / Sin datos reales; Documentación |
| Confirm idempotente, huérfanos, duplicados | submission / Idempotente; Huérfanos; history / Aviso de duplicado |

## Escenarios pedidos por el orquestador → dónde están

| Caso | Requisito (parte) |
|---|---|
| Happy path | submission / Botón y modal (1) |
| > 20 MB rechazado | validation / Tope 20 MB (1) |
| PUT ok pero confirm nunca llamado | submission / Huérfanos (1) |
| Confirm dos veces | submission / Confirm idempotente (1) |
| Tipo declarado vs bytes reales | validation / Magic bytes (1) |
| Falla del proveedor de mail | email / Estado del mail (2) |
| Reenviar | email / Reenviar mail (2) |
| Operator intenta acceder | admin / Operator no ve la feature (2) |
| Id de otro tenant | admin / Aislamiento entre tenants (2) |
| Cliente ve comprobante de otro | submission / Aislamiento del portal (1); history / Listado (1) |
| Marcar cargado / deshacer con auditoría | admin / Marcar/deshacer (2) |
| Duplicado mismo sha256 → avisa, no bloquea | history / Aviso de duplicado (1) |