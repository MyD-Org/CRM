# Funcionalidades del sistema — Portal CRM

> Estado al día de la última actualización. Portal B2B de autogestión para clientes
> de cuenta corriente, con datos del ERP **Alegra** y chat de soporte con IA.

## Índice

1. [Stack y arquitectura](#stack-y-arquitectura)
2. [Multitenant](#multitenant)
3. [Autenticación (OTP)](#autenticación-otp)
4. [Portal del cliente](#portal-del-cliente)
5. [Notificaciones](#notificaciones)
6. [Chat de soporte con IA](#chat-de-soporte-con-ia)
7. [Integración con Alegra (ERP)](#integración-con-alegra-erp)
8. [Base de datos](#base-de-datos)
9. [Feature flags](#feature-flags)
10. [Referencia de endpoints](#referencia-de-endpoints)
11. [Variables de entorno](#variables-de-entorno)
12. [Comandos](#comandos)

---

## Stack y arquitectura

- **Next.js 16** (App Router, server components, route handlers, middleware)
- **TypeScript** strict
- **Drizzle ORM** + driver `postgres` sobre **PostgreSQL** (local vía brew, Neon en prod)
- **iron-session** (sesiones por cookie)
- **Resend** (envío de emails)
- **Tailwind CSS**
- **Vercel Flags** (feature flags) y **Vercel Cron** (tareas programadas)

Flujo general: el navegador entra al portal → el middleware resuelve el tenant →
las páginas (server components) leen datos de Alegra y de la DB propia → el cliente
se autentica por OTP → opera sobre su cuenta corriente.

---

## Multitenant

Un mismo deploy sirve a múltiples clientes (tenants), cada uno con su config aislada
(Alegra, branding, WhatsApp, chat IA).

- **`src/middleware.ts`** — resuelve el tenant por subdominio (`cliente.dominio.com`)
  o por `TENANT_OVERRIDE` en dev. Corre en Edge runtime: solo valida que el ID exista
  (`isKnownTenantId`), sin tocar la DB. Inyecta el header `x-tenant-id`.
- **`src/lib/tenants.ts`** — `getTenantByIdFromDb()` carga la config completa del tenant
  desde la tabla `tenants`, con fallback a variables de entorno.
- **`src/lib/tenant-context.ts`** — `getTenantConfig()` lee el `x-tenant-id` y devuelve
  la config (usado por páginas y API routes, server runtime).

---

## Autenticación (OTP)

Login sin contraseña, por código de un solo uso (6 dígitos).

- **`POST /api/auth/send-code`** — recibe un identificador (ej. CUIT/email), genera un
  OTP de 6 dígitos válido **10 minutos** y lo guarda en una cookie de sesión OTP
  separada. *(Hoy el código se loguea por consola; falta cablear el envío real por email/SMS.)*
- **`POST /api/auth/verify-code`** — valida el código; si es correcto, busca el cliente
  en Alegra (contacto, por email/CUIT) y crea la sesión (`isLoggedIn`, `codigocliente`,
  `razonsocial`, `cuit`, `email`). El `codigocliente` es el id del contacto en Alegra.
- **`POST /api/auth/logout`** — destruye la sesión.

Dos cookies: `portal-session` (sesión principal) y `portal-otp` (verificación, TTL 10 min).
UI en **`LoginPage.tsx`** / ruta `/portal`.

---

## Portal del cliente

Ruta protegida `/portal/dashboard` (redirige a `/portal` si no hay sesión).

### Dashboard (`DashboardClient.tsx`)

- **Tarjetas resumen**: deuda total (con barra de uso de crédito), saldo vencido,
  saldo a vencer, con detalle de las principales facturas de cada grupo.
- **Tabs**: Facturas / Pagos / Presupuestos.
- **Facturas**: filtros por estado (todos/pendientes/vencidas/pagadas), búsqueda,
  filtro por fecha (emisión o vencimiento), ordenamiento por columnas, selección
  múltiple para descargar o consultar por WhatsApp. Soporta **pagos parciales**
  (muestra saldo restante).
- **Pagos**: recibos con sus facturas imputadas (un recibo puede cancelar varias
  facturas, total o parcialmente), búsqueda, filtro por fecha, ordenamiento.
- **Presupuestos**: estado (vigente/vencido/aceptado), búsqueda, filtro por fecha.
- **Navegación por URL**: acepta `?tab=&q=` para abrir una tab ya filtrada por
  comprobante (usado por las notificaciones).

### Condiciones comerciales (`/portal/condiciones`)

Vista de solo lectura con: condición de pago y crédito (barra de uso, roja >85%),
lista de precios y descuentos, vendedor asignado (con tel/mail), transporte y entregas.
Los datos viven en la **DB propia** (el ERP no las almacena).

### Header (`PortalHeader.tsx`)

Logo + subtítulo del tenant, chip "Tienda · Pronto" (deshabilitado), **campanita de
notificaciones** y menú de usuario (condiciones comerciales, salir).

---

## Notificaciones

### Gestor de cobranza (generación automática)

**`src/lib/notifications.ts` → `runNotifications()`**. Recorre las facturas impagas de
cada cliente, las cruza con las reglas del tenant (`notification_rules`) y envía
recordatorios por email (Resend). Deduplicación garantizada por unique index en
`notification_log`. Tipos generados:

- **`before_due_N`** — recordatorio N días **antes** del vencimiento (default: 3 y 1)
- **`after_due_N`** — aviso de mora N días **después** del vencimiento (default: 1, 7, 15)

Disparadores:
- **`POST /api/cron/notifications`** — corrida automática (Vercel Cron). Requiere `CRON_SECRET`.
- **`POST /api/notifications/send`** — disparo manual con filtros opcionales
  (`{ tenantId, codigocliente }`). Requiere `CRON_SECRET`.

Si no hay `RESEND_API_KEY`, hace **dry-run** (loguea sin enviar).

### Campanita en el portal

- **Badge** con la cantidad de **no leídas**.
- **Dropdown** con el historial (últimas 50), con **severidad visual**:
  por vencer (info/ámbar, ícono reloj) vs. vencida (rojo, ícono alerta).
- **Navegación**: cada notificación con destino lleva una flecha → que navega por URL
  (factura/pago/presupuesto → dashboard filtrado; condiciones → su página). Funciona
  desde cualquier página del portal.
- **Marcar como leída**: clic en la notificación (persistido en `read_at`, optimista) +
  botón **"Marcar todas como leídas"**.
- **`GET /api/notifications/log`** — historial del cliente logueado.
- **`PATCH /api/notifications/log`** — marca leídas (`{ ids }` o `{ all: true }`),
  siempre acotado al cliente de la sesión.

Tipo `conditions_changed` ("se modificaron tus condiciones") ya soportado en la UI.

> **Pendiente**: que `conditions_changed` se genere solo al editar una condición, y
> notificaciones de nuevo pago / nuevo presupuesto (a definir al conectar Alegra real).

---

## Chat de soporte con IA

Widget de chat embebido (proyecto `ai-widget`) conectado a `ai-api` (ambos de MyD-Org),
con las tools del agente consultando los datos reales del CRM.

- **`AiChat.tsx`** — monta el `ChatDrawer` con branding del tenant. Visible solo si el
  feature flag `ai-chat-enabled` está activo.
- **`POST /api/ai-token`** — crea una sesión de end-user en `ai-api` e incluye un
  `crm_token` (HMAC) en los claims, para que las tools del agente llamen al CRM como
  el usuario logueado.
- **Endpoints para el agente** (`/api/agent/*`), protegidos por Bearer token
  (`agent-auth.ts` + `agent-token.ts`, HMAC-SHA256, TTL 1h):
  - `GET /api/agent/invoices` — facturas (filtro `?status=paid|pending`)
  - `GET /api/agent/payments` — pagos
  - `GET /api/agent/account-balance` — saldo
- **CORS**: rewrite `/ai-api/*` → `ai-api` (configurado en `next.config.ts`).

---

## Integración con Alegra (ERP)

Alegra es el **ERP** del portal: reemplazó a Flexxus. Dos capas:

**`src/lib/alegra.ts`** — cliente de la API de Alegra (auth HTTP Basic `email:token`).
Credenciales por tenant (`{PREFIX}_ALEGRA_EMAIL/TOKEN`); sin credenciales corre en
**mock** (`mock-alegra.ts`). El mock se apaga solo al setear el token.

- **Catálogo**: `listAllCategories`, `listAllItems` — sync a cache local
  (`alegra-sync.ts`, cron `/api/cron/alegra-sync`) — y `getItemsLive` (precio/stock al momento).
- **Contactos (clientes)**: `searchContacts`, `getContact`, `listAllContacts`.
- **Cuenta corriente**: `listInvoicesByContact`, `listPaymentsByContact`, `getContactBalance`
  (deuda total / vencido / a vencer, derivado de las facturas abiertas).
- **Config de venta**: `listPriceLists`, `listPaymentTerms` (`/terms`), `listSellers`,
  `listTaxes`, `listCurrencies`.
- **Cotizaciones (estimates)**: `createEstimate`, `getEstimate`, `listEstimatesByContact`,
  `deleteEstimate`. Es la **única escritura** permitida contra Alegra: una cotización no es
  documento fiscal y se puede borrar por API. No exponer creación de facturas/pagos.

**`src/lib/erp.ts`** — adaptador que traduce Alegra a los tipos de dominio del portal
(`Cliente`, `Factura`, `Pago`, `Presupuesto`). Es lo que consumen el portal (dashboard,
login, condiciones), los endpoints `/api/agent/*` y el gestor de cobranza. En modo
`alegraMock` devuelve los fixtures de `mock-data.ts` — el portal funciona en dev sin
credenciales. Fechas normalizadas a `DD/MM/YYYY`; estados de Alegra mapeados a
`FacturaEstado`/`PresupuestoEstado`.

- `getCliente`, `getClienteByIdentifier` (login por email/CUIT), `getClientes`,
  `getFacturas`, `getPagos`, `getPresupuestos`.
- `getCondiciones` — **excepción**: las condiciones comerciales NO están en Alegra,
  se leen de la DB propia (con fallback a mock).

> ⚠ Las cuentas de Alegra son **reales** (no hay sandbox). Smoke test contra una cuenta:
> `npm run alegra:smoke -- --tenant new-avantec` (solo lecturas) o con `--write-test`
> (crea una cotización marcada TEST y la **borra en el mismo run**).
>
> **Límite de crédito**: Alegra no expone un límite de crédito por contacto, así que hoy
> `Cliente.limitecredito` es 0 (la barra de uso de crédito del portal no muestra tope).
> A resolver desde la DB propia si se necesita.

---

## Base de datos

DB propia del CRM (Postgres). Schema en **`src/db/schema.ts`** (Drizzle):

| Tabla | Descripción |
|---|---|
| `tenants` | Config por tenant (reemplaza las env vars `{PREFIX}_*`) |
| `client_commercial_conditions` | Condiciones comerciales por cliente (unique en tenant+cliente) |
| `notification_rules` | Reglas de notificación por tenant (días antes/después, canales) |
| `notification_log` | Historial de notificaciones; dedup por unique index; columna `read_at` |

- **`src/db/index.ts`** — singleton de conexión (`prepare: false` para Neon/pgbouncer).
- **`src/db/migrate.ts`** — aplica migraciones de `drizzle/`.
- **`src/db/seed.ts`** — seed idempotente (tenant central-led, condiciones CLI001, reglas default).

---

## Feature flags

**`src/lib/flags.ts`** (Vercel Flags). Flag actual:

- **`ai-chat-enabled`** (default `false`) — muestra la burbuja del chat de soporte.
  En dev se controla por env `AI_CHAT_ENABLED=true`.

---

## Referencia de endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/auth/send-code` | — | Genera y "envía" el OTP |
| POST | `/api/auth/verify-code` | OTP cookie | Valida OTP y crea sesión |
| POST | `/api/auth/logout` | sesión | Cierra sesión |
| GET | `/api/notifications/log` | sesión | Historial de notificaciones |
| PATCH | `/api/notifications/log` | sesión | Marca leídas (`ids` o `all`) |
| POST | `/api/notifications/send` | `CRON_SECRET` | Disparo manual del gestor de cobranza |
| POST/GET | `/api/cron/notifications` | `CRON_SECRET` | Disparo automático (Vercel Cron) |
| POST | `/api/ai-token` | sesión | Token de sesión para el chat IA |
| GET | `/api/agent/invoices` | agent token | Facturas (para el agente) |
| GET | `/api/agent/payments` | agent token | Pagos (para el agente) |
| GET | `/api/agent/account-balance` | agent token | Saldo (para el agente) |
| GET | `/api/agent/contacts` | agent token | Busca clientes en Alegra (`?q=`) |
| POST | `/api/agent/quotes` | agent token | Crea una cotización en Alegra |
| GET | `/api/agent/quotes` | agent token | Cotizaciones de un contacto (`?contact_id=`) |
| GET | `/api/agent/sales-config` | agent token | Listas de precio, condiciones de pago, vendedores, impuestos, monedas + link del shop |

---

## Variables de entorno

| Variable | Para qué |
|---|---|
| `SESSION_SECRET` | Firma de sesiones y agent tokens |
| `RESEND_API_KEY` | Envío de emails (sin esto, dry-run) |
| `TENANT_IDS` | Lista de tenants activos |
| `TENANT_OVERRIDE` | Forzar un tenant en dev |
| `CENTRAL_LED_*` | Config del tenant (NAME, SUBTITLE, LOGO, MOCK, WHATSAPP, RESEND_FROM, AI_API_URL, AI_API_KEY, AI_AGENT_ID) |
| `{PREFIX}_MOCK` | `true` → el portal corre con fixtures (`mock-data.ts`) sin pegarle a Alegra |
| `{PREFIX}_ALEGRA_EMAIL` / `{PREFIX}_ALEGRA_TOKEN` | Credenciales de Alegra del tenant (sin token → mock) |
| `{PREFIX}_ALEGRA_MOCK` | Fuerza el mock de Alegra aunque haya token |
| `NEXT_PUBLIC_SHOP_URL` | Link de la tienda que comparte el agente (`sales-config`) |
| `DATABASE_URL` | Conexión Postgres |
| `CRON_SECRET` | Protege los endpoints de notificaciones |
| `AI_CHAT_ENABLED` | Activa el chat en dev |

---

## Comandos

```bash
npm run dev          # servidor de desarrollo
npm run build        # build de producción
npm run lint         # eslint
npm run db:generate  # generar migración desde el schema
npm run db:migrate   # aplicar migraciones
npm run db:seed      # seed inicial
npm run alegra:smoke # smoke test de Alegra (-- --tenant <id> [--write-test])
```
