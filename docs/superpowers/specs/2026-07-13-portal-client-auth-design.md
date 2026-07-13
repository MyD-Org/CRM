# Diseño — Login de clientes del portal (contraseña provisoria + Google)

**Fecha:** 2026-07-13
**Tenant de referencia:** central-led
**Estado:** aprobado (brainstorming), pendiente plan de implementación

## Contexto y problema

El portal de clientes autentica hoy con **OTP + `iron-session`** (`src/app/api/auth/{send-code,verify-code}`). Ese flujo nunca fue usable en producción:

- `send-code` no tiene canal de entrega real: solo devuelve el código como `devCode` fuera de producción; en prod el OTP no llega a ningún lado (marcado como riesgo abierto en el propio código).
- Los contactos en Alegra de central-led tienen **solo CUIT**: 0 email, 0 teléfono (verificado contra la API real). No hay a dónde mandar un OTP ni con qué matchear un login por email.

El único identificador confiable del cliente es el **CUIT**, que además es **público** (facturas, padrón AFIP) → no puede usarse como secreto.

**Objetivo:** un login real para clientes del portal que funcione con los datos existentes, con recuperación de cuenta, y con "Entrar con Google" como comodidad.

## Decisiones tomadas

1. **Usuario = CUIT o email**; primera contraseña **provisoria aleatoria** entregada por el operador; primer ingreso fuerza cambio de contraseña + captura de email.
2. **Google login incluido en v1**, implementado con **OAuth manual + `iron-session`** (opción A): flujo propio + `google-auth-library` solo para verificar el `id_token`. Se mantiene un único modelo de sesión. Descartados Auth.js (choca con iron-session/binding a Alegra) y Clerk (costo + binding custom igual necesario).
3. El vínculo con Alegra se ancla en `codigocliente` (id de contacto), asignado por el **operador** en el alta. Google nunca crea el vínculo: solo resuelve una cuenta ya ligada.

## Modelo de datos

### Tabla nueva `portal_users`

Credenciales del cliente del portal, en la DB propia (Alegra no guarda nada de esto).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | pk | |
| `tenant_id` | fk `tenants` | |
| `codigocliente` | text | **vínculo con Alegra** (id de contacto) |
| `cuit` | text | handle de login; **normalizado a solo dígitos** al guardar y al buscar (en Alegra viene con guiones, el cliente tipea sin) |
| `email` | text nullable | null solo hasta el setup (ahí es **obligatorio**); login + recuperación |
| `password_hash` | text | scrypt vía `admin-crypto`; siempre presente (provisoria o definitiva) — Google es un extra, nunca el único método |
| `google_id` | text nullable | `sub` de Google; null si no vinculó |
| `must_change_password` | boolean, default true | fuerza el setup inicial |
| `provisional_expires_at` | timestamp nullable | vencimiento de la provisoria (7 días) |
| `status` | text, default `active` | `active` / `disabled` |
| `failed_attempts` | int, default 0 | anti-fuerza-bruta |
| `locked_until` | timestamp nullable | lockout temporal (ver Seguridad) |
| `last_login_at` | timestamp nullable | |
| `created_at`, `updated_at` | timestamp | |

**Únicos por tenant:** `codigocliente`; `cuit`; `email` (parcial, where not null); `google_id` (parcial, where not null).

### Tabla nueva `portal_password_tokens`

Espejo de `admin_password_tokens` para el reset por email: `id`, `portal_user_id` (fk), `token_hash`, `expires_at`, `used_at`.

## Flujos

### Alta (operador) — página admin "Clientes"

Nueva página admin que lista contactos de Alegra (reusa `getClientes`, ya implementada) con búsqueda por CUIT/nombre y botón **"Generar acceso"**:

1. Genera una provisoria aleatoria (crypto, ~12 chars).
2. Crea/actualiza la fila `portal_users`: `must_change=true`, `password_hash` de la provisoria, `provisional_expires_at = now + 7d`, `codigocliente` y `cuit` (normalizado) del contacto.
3. Muestra la provisoria **una sola vez** para copiar y entregar al cliente.

**Regenerar** usa el mismo botón: si la fila ya existe, resetea `password_hash`, `provisional_expires_at`, `must_change=true`, `failed_attempts=0` y `locked_until=null`. Sirve tanto para provisoria vencida como para destrabar a un cliente bloqueado.

### Primer ingreso del cliente

1. Login con **CUIT + provisoria**. Si la provisoria está vencida (`provisional_expires_at < now`): error claro — "tu clave provisoria venció, pedile una nueva a tu vendedor" — y el operador la regenera desde el admin.
2. `must_change=true` → redirige a `/portal/setup` con sesión parcial "pending-setup".
3. Form: **nueva contraseña + email (ambos obligatorios)** (+ opcional "Vincular Google"). Si vincula Google y aún no tipeó email, se pre-llena con el de Google (editable).
4. `POST /api/auth/setup`: valida, hashea la nueva contraseña, guarda email, `must_change=false`. Si vincula Google, round-trip OAuth **dentro de esta sesión autenticada** que persiste el `google_id`.
5. Sesión completa → dashboard.

### Ingresos siguientes

- **Contraseña**: `POST /api/auth/login` → busca por CUIT (normalizado) o email → `verifyPassword` → sesión completa (poblada desde Alegra con `getCliente(codigocliente)`, igual que hoy `verify-code`) → dashboard. Incrementa `failed_attempts`; lockout tras 5 (ver Seguridad).
- **Google**: `GET /api/auth/google/start` (redirect con `state` CSRF en cookie corta) → `GET /api/auth/google/callback` (intercambia code → verifica `id_token` con audience = client id → `google_id` + email) → busca por `google_id`:
  - vinculado y activo → sesión completa → dashboard.
  - no vinculado → error: "tu Google no está asociado, ingresá con CUIT + la contraseña que te pasaron".

**El callback tiene doble rol**, discriminado por el `state`: modo `login` (arriba) y modo `link` (vincular desde el setup o la cuenta). `link` solo procede si existe una sesión pending-setup o completa activa; sin sesión, se rechaza. El `state` firmado en cookie corta cubre CSRF en ambos modos.

### Recuperación

- `POST /api/auth/forgot` (por email) → crea token hasheado con vencimiento en `portal_password_tokens` → envía mail por Resend (reusa patrón admin) → **siempre responde OK** (no filtra existencia).
- `/portal/reset/[token]` → nueva contraseña.
- Si tiene Google vinculado, alternativamente entra con Google.

## Sesión

`iron-session` sin cambios estructurales. Se agrega un marcador transitorio "pending-setup" para el gate del primer ingreso. La `SessionData` completa (`codigocliente`, `razonsocial`, `cuit`, `email`, `tipoCuenta`) se puebla desde Alegra al loguear, idéntico al `verify-code` actual.

## Seguridad

- Provisoria: aleatoria (crypto), hasheada (scrypt), `must_change`, vence a 7 días. **Nunca el CUIT.**
- Google: match por `google_id` (`sub`), vinculado **solo** en sesión autenticada; verificación del `id_token` con `google-auth-library` (audience = client id); `state` param para CSRF.
- Lockout por cuenta (en DB, funciona en serverless): tras 5 intentos fallidos (`failed_attempts`, espejo del `MAX_OTP_ATTEMPTS` actual) se setea `locked_until = now + 15 min`. Se destraba solo al vencer, o antes si el operador regenera la provisoria o el cliente resetea por email. Login exitoso resetea el contador.
- `forgot`: cooldown por usuario en DB — máximo 1 token de reset cada 5 minutos. (Rate-limit por IP queda fuera de v1: en Vercel serverless un limiter en memoria no persiste; si hiciera falta, WAF de Vercel.)
- CUIT normalizado a solo dígitos en alta y login (evita fallos por guiones).
- Unicidad de email por tenant en el setup (no reclamar el email de otro cliente).
- Cookie sellada `httpOnly` sin cambios.

## Reemplazo del OTP

Los endpoints `send-code` / `verify-code` y la UI de OTP quedan **reemplazados** por este flujo. Se eliminan (o se dejan deshabilitados) al cerrar la migración.

## Config externa

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (OAuth client en Google Cloud Console, uno por entorno).
- `RESEND_API_KEY` ya configurada.

## Testing

- Reusa tests de `admin-crypto`.
- Unit: generación de provisoria, `verifyPassword`, normalización de CUIT (con/sin guiones), lookup por `google_id`, token de reset, unicidad de email.
- Integración: login por CUIT/email/Google, provisoria vencida, gate de setup (`must_change` bloquea el dashboard), lockout y destrabe (15 min / regeneración / reset), callback en modo `link` sin sesión (rechazo), recuperación con cooldown.

## Fuera de alcance (v1)

- Auto-registro del cliente sin operador.
- Write-back del email capturado a Alegra (enriquecer el contacto) — evaluar en una iteración posterior.
- Otros proveedores sociales (solo Google).
- **Múltiples usuarios por cliente**: v1 tiene 1 usuario por contacto de Alegra (una persona por empresa). Limitación conocida y aceptada; si un B2B necesita más personas, se evalúa en v2 (tabla de miembros por cliente).
- Rate-limit por IP (ver Seguridad).
