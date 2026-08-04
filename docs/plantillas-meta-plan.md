# Plantillas de WhatsApp (Meta Message Templates) — ABM multi-tenant

> Plan de implementación cross-repo (CRM + ai-api). Escrito el 2026-08-04.
> Ver también las memorias: `meta-tech-provider-plantillas`, `whatsapp-coexistence-onboarding`,
> `drizzle-migrations-desync`.

## Context

Somos Tech Provider de Meta desde julio 2026. Hoy los clientes que quieren crear/editar/borrar
plantillas de WhatsApp Business tienen que ir al Business Manager de Meta. El objetivo es que
puedan hacerlo desde el admin del CRM, y como subproducto tener el screencast que Meta pide
para aprobar `whatsapp_business_management` con Advanced Access.

Multi-tenant desde el arranque: nada de hardcodear `waba_id` ni operar solo contra Central Led.
Cuando un nuevo cliente completa el Embedded Signup, el ABM tiene que funcionar automáticamente
sobre su WABA.

**Gaps encontrados durante la exploración que el plan corrige:**

1. `ai-api/src/routes/onboarding.ts:112-117` cifra `secretsEncrypted` con solo
   `{appSecret, verifyToken, accessToken, graphVersion}`. El `wabaId` se descubre por
   `debug_token` pero **no se persiste**. Para el ABM de plantillas necesitamos el `wabaId`
   en cada request — hay que agregarlo al blob cifrado en el onboarding.
2. `ai-api/src/routes/onboarding.ts:64` hoy resuelve el tenant por
   `WA_ONBOARD_TENANT_NAME ?? 'Central Led'`. Para multi-tenant real hay que aceptar el
   tenant como parte del signup (state HMAC) — **fuera del scope de este plan**, se documenta
   como pre-requisito conocido.

**Decisiones tomadas:**
- Persistencia de plantillas **solo en ai-api** (no espejo local en CRM). El CRM las lee vía
  `/v1/staff/templates` en cada carga.
- Refactor del onboarding multi-tenant queda fuera de scope; se ataca cuando llegue el segundo
  cliente.

## Approach

Seis fases con dependencias claras. Fase 0 es bloqueante — si Meta devuelve 403,
saltamos a Fase 6 y mockeamos.

### Fase 0 — Verificación empírica de permisos (1h, bloqueante)

Script one-off que descifra `secretsEncrypted` de un `channel_accounts` real, extrae
`accessToken`, hace `GET /debug_token` para sacar el `wabaId`, y prueba:

```bash
curl -sS "https://graph.facebook.com/v21.0/${WABA_ID}/message_templates?limit=5" \
  -H "Authorization: Bearer ${AT}" | jq .

curl -sS -X POST "https://graph.facebook.com/v21.0/${WABA_ID}/message_templates" \
  -H "Authorization: Bearer ${AT}" -H "Content-Type: application/json" \
  -d '{"name":"crm_probe","category":"UTILITY","language":"es_AR",
       "components":[{"type":"BODY","text":"Hola {{1}}","example":{"body_text":[["Ana"]]}}]}'
```

Salida esperada: 200 con `{id, status, category}`. Si 403/(#200)/(#10), documentar y
priorizar Fase 6.

### Fase 1 — ai-api: schema + servicio + rutas

**Persistir `wabaId`** (corrige gap #1):
- Extender el tipo de secrets en `ai-api/src/channels/accounts.ts` para incluir `wabaId`.
- En `ai-api/src/routes/onboarding.ts:112-117`, sumar `wabaId` al `encryptSecrets`.
- Script one-off `ai-api/scripts/backfill-waba-id.ts` que, para las filas existentes, descifra
  → llama `debug_token` con el `accessToken` guardado → recifra con `wabaId`. Documentar cómo
  correrlo contra prod.

**Nueva tabla `whatsapp_templates`** en `ai-api/src/db/schema.ts` (después de línea 213):

```ts
export const whatsappTemplates = pgTable('whatsapp_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  channelAccountId: uuid('channel_account_id').notNull().references(() => channelAccounts.id),
  wabaId: text('waba_id').notNull(),
  metaTemplateId: text('meta_template_id'),
  name: text('name').notNull(),
  category: text('category').notNull(),        // MARKETING | UTILITY | AUTHENTICATION
  language: text('language').notNull(),
  status: text('status').notNull().default('PENDING'),
  components: jsonb('components').notNull(),
  rejectionReason: text('rejection_reason'),
  qualityScore: jsonb('quality_score'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('wa_tpl_tenant_name_lang').on(t.tenantId, t.name, t.language),
  index('wa_tpl_waba').on(t.wabaId),
  index('wa_tpl_meta_id').on(t.metaTemplateId),
]);
```

Generar migration `drizzle/0019_*.sql` con `pnpm drizzle-kit generate`.
**Prod**: aplicar el `.sql` con `psql` a mano por historial de desincronización (ver memoria
`drizzle-migrations-desync.md`).

**Helper HTTP** en `ai-api/src/channels/graph-client.ts` (nuevo): función
`graphFetch(url, init, secrets, {retryOn5xx})` que replica el patrón de retry lineal de
`sender.ts:79-128` (timeout 10s, 5xx→retry, 4xx→no). Sin abstracción de más — se reusa desde
el servicio de templates.

**Servicio** en `ai-api/src/channels/templates/service.ts` (nuevo):
- `listRemote(account, {after?, status?})` → `GET /{wabaId}/message_templates`.
- `createRemote(account, {name, category, language, components})` → `POST /{wabaId}/message_templates`.
- `editRemote(account, metaTemplateId, {components})` → `POST /{metaTemplateId}`.
- `deleteRemote(account, {name, hsmId?})` → `DELETE /{wabaId}/message_templates?name=...`.
- `upsertLocal(db, row)` con `.onConflictDoUpdate` por `(tenantId, name, language)`.
- `reconcile(db, account)` que pagina LIST y upserta masivo.

`account` viene de `getChannelAccount(...)` (patrón existente en `ai-api/src/channels/accounts.ts`).
Si `account.secrets.wabaId` falta, 409 `{error:'waba_not_configured'}`.

**Rutas staff** en `ai-api/src/routes/templates.ts` (nuevo), registradas en `ai-api/src/app.ts`.
Todas con `{ onRequest: app.requireStaff }` (patrón de `inbox.ts:146+`), `req.tenantId` viene del JWT:

- `GET /v1/staff/templates?status=&search=` — lista local.
- `POST /v1/staff/templates` — valida name `^[a-z0-9_]{1,512}$`, llama `createRemote`, upsert local.
- `POST /v1/staff/templates/:id/sync` — refetch por `metaTemplateId`, upsert.
- `PATCH /v1/staff/templates/:id` — solo components (400 si status=PENDING).
- `DELETE /v1/staff/templates/:id` — deleteRemote, soft-delete local (`deletedAt`).
- `POST /v1/staff/templates/sync-all` — reconcile completo.

Reusar `encryptSecrets`/`decryptSecrets` (`ai-api/src/auth/secrets.ts`) y `app.requireStaff`
(`ai-api/src/auth/plugin.ts:70-83`). Tests con fetch mockeado siguiendo el patrón de `sender.ts`.

### Fase 2 — ai-api: webhooks de plantillas

Extender el switch en `ai-api/src/routes/webhooks.ts:110-124`. Meta manda estos `field`
dentro de `changes[]` con `object='whatsapp_business_account'`:

- `message_template_status_update` — APPROVED / REJECTED / PAUSED / DISABLED / IN_APPEAL.
- `message_template_quality_update` — cambio de quality score.
- `template_category_update` — Meta recategoriza (afecta pricing).

Nuevo parser `ai-api/src/channels/parsers/templates.ts` que devuelve `TemplateEvent[]` desde
`body.entry[].changes[]`.

Nueva rama en el switch:

```ts
const tplEvents = parseTemplateEvents(body);
if (tplEvents.length) {
  app.trackBackgroundTask(applyTemplateEvents(app, account, tplEvents));
}
```

`applyTemplateEvents` hace UPDATE por `(tenantId, metaTemplateId)` con fallback a
`(tenantId, name, language)`. Idempotente. Se ack-ea 200 antes de procesar.

**Config Meta App**: agregar `message_template_status_update`, `message_template_quality_update`,
`template_category_update` a la suscripción de `WhatsApp Business Account`. Documentar en
README de ai-api.

### Fase 3 — CRM: proxy `/api/admin/templates/*`

Nuevos handlers en `CRM/src/app/api/admin/templates/`:
- `route.ts` — GET (list) y POST (create).
- `[id]/route.ts` — PATCH, DELETE.
- `[id]/sync/route.ts` — POST.
- `sync-all/route.ts` — POST.

Patrón por handler (mismo que otros `/api/admin/*`):

```ts
const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions);
if (!session.userId) return NextResponse.json({error:'no autorizado'}, {status:401});
if (session.role !== 'superadmin') return NextResponse.json({error:'forbidden'}, {status:403});
const tenant = await getTenantConfig();
const token = await mintInboxToken(tenant.aiTenantId, session.role);
const res = await fetch(`${tenant.aiApiUrl}/v1/staff/templates${path}`, {
  method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
  body: bodyString,
});
return new NextResponse(await res.text(), {
  status: res.status, headers: {'content-type':'application/json'},
});
```

Reusar `mintInboxToken` (`CRM/src/lib/inbox-token.ts:6`, firma `(aiTenantId, role?)→JWT HS256`
TTL 5min) y `getTenantConfig` (`CRM/src/lib/tenant-context.ts:4`).

**No usar `INTERNAL_SECRET`** acá: eso es solo para el callback público del onboarding.

### Fase 4 — CRM: UI en admin

Nuevo directorio `CRM/src/app/admin/(protected)/plantillas/`:
- `page.tsx` — ServerComponent (patrón de `admin/(protected)/catalogo/page.tsx:12-76`).
  Valida `session.role === 'superadmin'`, resuelve tenant, mintea staff token, hace fetch a
  `${aiApiUrl}/v1/staff/templates` en el server (cache: no-store), pasa `initialTemplates` al
  client. Si el fetch falla, renderiza mensaje "no se pudo cargar" sin romper el árbol.

Nuevos client components:
- `CRM/src/components/admin/TemplateList.tsx` — tabla `@myd-org/ui` con name, language,
  category, status (Badge coloreado por estado), botones **Nueva**, **Editar** (disabled si
  status=PENDING), **Sincronizar**, **Borrar** (Dialog confirmación), **Sincronizar todo**.
  Mutations pegan a `/api/admin/templates/*` y refrescan con `router.refresh()`.
- `CRM/src/components/admin/TemplateForm.tsx` — Dialog + form. Campos:
  - `name` (Input, disabled en edit — Graph no permite renombrar).
  - `category` (Select: MARKETING / UTILITY / AUTHENTICATION).
  - `language` (Select con `es_AR`, `es_ES`, `en_US`, `pt_BR` + override manual).
  - `body` (Textarea, valida `{{n}}` secuencial arrancando en `{{1}}`).
  - `examples` (Input por cada placeholder detectado — Meta exige para MARKETING/UTILITY).
  - `header` (opcional, TEXT), `footer` (opcional).

  Al submit, arma `components[]` según Graph:
  ```json
  [{"type":"BODY","text":"Hola {{1}}, ...",
    "example":{"body_text":[["Ana"]]}}]
  ```

Link "Plantillas" en el sidebar (`CRM/src/components/admin/AdminShell.tsx`), visible solo
si `role === 'superadmin'`.

### Fase 5 — Embedded Signup: scope y persistencia

`whatsapp_business_management` **ya se está pidiendo** en el signup (evidencia:
`ai-api/src/routes/onboarding.ts:82` lo lee de `granular_scopes`). Verificar que el link/config
del Embedded Signup en la Meta App lo tenga en el `feature_type` — buscar dónde se genera el
link (probablemente config manual en Meta App, no en código).

**Cambio de código**: en `ai-api/src/routes/onboarding.ts:112-117` sumar `wabaId` al blob cifrado
(sale del bloque de `debug_token` en línea 82). Sin esto, cada llamada de templates tendría
que redescubrir el `wabaId` por debug_token → costo extra.

### Fase 6 — App Review (Advanced Access)

Screencast (≤3 min) mostrando end-to-end con una WABA que **no** sea la propia:
1. Login del admin en el CRM.
2. Navegar a `/admin/plantillas`.
3. Crear template → aparece PENDING en la tabla.
4. Mostrar en Business Manager que el template aparece "In review".
5. (Opcional) Editar body, borrar.

Justificación del permiso: "Our SaaS onboards businesses via Embedded Signup as Tech Provider.
Once connected, admins manage message templates from our UI so they don't context-switch to
Meta Business Manager."

**Requisitos previos que no dependen de este plan**:
- Business verification del cliente aprobada (Central Led hoy: rechazada por nombre DNI ≠ FB
  — ver memoria `shop-gate-proximamente-dominio.md`).

## Dependencias entre fases

Fase 0 → 1 (schema + servicio + rutas + backfill del wabaId) → 2 (webhooks, en paralelo con 3)
→ 3 (proxy CRM) → 4 (UI) → 6 (App Review submission).
Fase 5 corre en paralelo con Fase 1 (config Meta App independiente del código).

## Critical files

**ai-api (nuevos)**:
- `ai-api/src/routes/templates.ts`
- `ai-api/src/channels/templates/service.ts`
- `ai-api/src/channels/graph-client.ts`
- `ai-api/src/channels/parsers/templates.ts`
- `ai-api/scripts/backfill-waba-id.ts`
- `ai-api/drizzle/0019_*.sql` (drizzle-kit generado)

**ai-api (modificar)**:
- `ai-api/src/db/schema.ts` — agregar `whatsappTemplates`.
- `ai-api/src/channels/accounts.ts` — sumar `wabaId` al tipo de secrets.
- `ai-api/src/routes/onboarding.ts:112-117` — persistir `wabaId` en `encryptSecrets`.
- `ai-api/src/routes/webhooks.ts:110-124` — ruteo de eventos de plantilla.
- `ai-api/src/app.ts` — registrar `templateRoutes`.

**CRM (nuevos)**:
- `CRM/src/app/admin/(protected)/plantillas/page.tsx`
- `CRM/src/components/admin/TemplateList.tsx`
- `CRM/src/components/admin/TemplateForm.tsx`
- `CRM/src/app/api/admin/templates/route.ts`
- `CRM/src/app/api/admin/templates/[id]/route.ts`
- `CRM/src/app/api/admin/templates/[id]/sync/route.ts`
- `CRM/src/app/api/admin/templates/sync-all/route.ts`

**CRM (modificar)**:
- `CRM/src/components/admin/AdminShell.tsx` — item "Plantillas" en sidebar (solo superadmin).

## Verification (end-to-end)

1. **Fase 0**: `curl` contra Meta devuelve 200 para LIST y CREATE con el token real de una WABA.
2. **Fase 1**: `pnpm test` en ai-api pasa. `curl` a `POST /v1/staff/templates` con staff token
   válido crea en Meta y aparece en `SELECT * FROM whatsapp_templates`.
3. **Fase 2**: simular `POST /webhooks/meta/:accountId` con body de `message_template_status_update`
   → el status en DB pasa a APPROVED sin polling.
4. **Fase 3**: `curl` con cookie de admin superadmin del CRM → 200; sin cookie → 401; con rol
   distinto de superadmin → 403.
5. **Fase 4**: en el admin del CRM `/admin/plantillas`:
   - Crear template → aparece PENDING en tabla.
   - Después del webhook, click "Sincronizar" (o `router.refresh()`) → APPROVED.
   - Editar body → cambia sin error.
   - Borrar → desaparece de la lista, existe con `deletedAt` en DB.
6. **Fase 5**: onboardear un tenant nuevo end-to-end y verificar que `channel_accounts.secrets_encrypted`
   contiene `wabaId` después del canje.
7. **Fase 6**: crear el video de screencast usando la UI ya construida contra Central Led.

## Riesgos

- **Meta rate limit** 200 templates/día/WABA. UI muestra 429 sin reintentar.
- **Recategorización unilateral** via `template_category_update`: el webhook debe pisar la
  categoría local, no la elegida por el admin.
- **Delete por nombre vs `hsm_id`**: borrar por nombre borra todas las lenguas; la UI debe
  ser explícita (checkbox "borrar solo este idioma" opcional).
- **Token expiration**: si Meta revoca el access token, `graphFetch` devuelve 401 → propagar
  como `{error:'meta_reauth_required'}` para forzar re-onboarding.
- **`drizzle-migrations-desync`**: aplicar `0019_*.sql` a prod con `psql` + INSERT en
  `__drizzle_migrations`, no `drizzle-kit migrate` a ciegas.
- **Onboarding hardcodea `Central Led`** (`onboarding.ts:64`) — no bloquea este plan (Central
  Led es el único cliente hoy) pero para el segundo cliente hay que refactorizar el onboarding
  para resolver tenant desde el state HMAC.
