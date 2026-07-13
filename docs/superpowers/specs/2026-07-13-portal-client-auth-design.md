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
| `cuit` | text | handle de login |
| `email` | text nullable | capturado en 1er ingreso; login + recuperación |
| `password_hash` | text nullable | scrypt vía `admin-crypto`; null si solo usa Google |
| `google_id` | text nullable | `sub` de Google; null si no vinculó |
| `must_change_password` | boolean, default true | fuerza el setup inicial |
| `provisional_expires_at` | timestamp nullable | vencimiento de la provisoria (7 días) |
| `status` | text, default `active` | `active` / `disabled` |
| `failed_attempts` | int, default 0 | anti-fuerza-bruta |
| `last_login_at` | timestamp nullable | |
| `created_at`, `updated_at` | timestamp | |

**Únicos por tenant:** `codigocliente`; `cuit`; `email` (parcial, where not null); `google_id` (parcial, where not null).

### Tabla nueva `portal_password_tokens`

Espejo de `admin_password_tokens` para el reset por email: `id`, `portal_user_id` (fk), `token_hash`, `expires_at`, `used_at`.

## Flujos

### Alta (operador) — página admin "Clientes"

Nueva página admin que lista contactos de Alegra (reusa `getClientes`, ya implementada) con búsqueda por CUIT/nombre y botón **"Generar acceso"**:

1. Genera una provisoria aleatoria (crypto, ~12 chars).
2. Crea/actualiza la fila `portal_users`: `must_change=true`, `password_hash` de la provisoria, `provisional_expires_at = now + 7d`, `codigocliente` y `cuit` del contacto.
3. Muestra la provisoria **una sola vez** para copiar y entregar al cliente.

### Primer ingreso del cliente

1. Login con **CUIT + provisoria**.
2. `must_change=true` → redirige a `/portal/setup` con sesión parcial "pending-setup".
3. Form: **nueva contraseña + email** (+ opcional "Vincular Google").
4. `POST /api/auth/setup`: valida, hashea la nueva contraseña, guarda email, `must_change=false`. Si vincula Google, round-trip OAuth **dentro de esta sesión autenticada** que persiste el `google_id`.
5. Sesión completa → dashboard.

### Ingresos siguientes

- **Contraseña**: `POST /api/auth/login` → busca por CUIT o email → `verifyPassword` → sesión completa (poblada desde Alegra con `getCliente(codigocliente)`, igual que hoy `verify-code`) → dashboard. Incrementa `failed_attempts`; lockout tras 5.
- **Google**: `GET /api/auth/google/start` (redirect con `state` CSRF en cookie corta) → `GET /api/auth/google/callback` (intercambia code → verifica `id_token` con audience = client id → `google_id` + email) → busca por `google_id`:
  - vinculado y activo → sesión completa → dashboard.
  - no vinculado → error: "tu Google no está asociado, ingresá con CUIT + la contraseña que te pasaron".

### Recuperación

- `POST /api/auth/forgot` (por email) → crea token hasheado con vencimiento en `portal_password_tokens` → envía mail por Resend (reusa patrón admin) → **siempre responde OK** (no filtra existencia).
- `/portal/reset/[token]` → nueva contraseña.
- Si tiene Google vinculado, alternativamente entra con Google.

## Sesión

`iron-session` sin cambios estructurales. Se agrega un marcador transitorio "pending-setup" para el gate del primer ingreso. La `SessionData` completa (`codigocliente`, `razonsocial`, `cuit`, `email`, `tipoCuenta`) se puebla desde Alegra al loguear, idéntico al `verify-code` actual.

## Seguridad

- Provisoria: aleatoria (crypto), hasheada (scrypt), `must_change`, vence a 7 días. **Nunca el CUIT.**
- Google: match por `google_id` (`sub`), vinculado **solo** en sesión autenticada; verificación del `id_token` con `google-auth-library` (audience = client id); `state` param para CSRF.
- Rate-limit en `login` y `forgot`; lockout tras 5 intentos fallidos (`failed_attempts`), espejo del `MAX_OTP_ATTEMPTS` actual.
- Unicidad de email por tenant en el setup (no reclamar el email de otro cliente).
- Cookie sellada `httpOnly` sin cambios.

## Reemplazo del OTP

Los endpoints `send-code` / `verify-code` y la UI de OTP quedan **reemplazados** por este flujo. Se eliminan (o se dejan deshabilitados) al cerrar la migración.

## Config externa

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (OAuth client en Google Cloud Console, uno por entorno).
- `RESEND_API_KEY` ya configurada.

## Testing

- Reusa tests de `admin-crypto`.
- Unit: generación de provisoria, `verifyPassword`, lookup por `google_id`, token de reset, unicidad de email.
- Integración: login por CUIT/email/Google, gate de setup (`must_change` bloquea el dashboard), recuperación, rate-limit.

## Fuera de alcance (v1)

- Auto-registro del cliente sin operador.
- Write-back del email capturado a Alegra (enriquecer el contacto) — evaluar en una iteración posterior.
- Otros proveedores sociales (solo Google).
