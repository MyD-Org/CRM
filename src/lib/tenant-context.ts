import { headers } from "next/headers"
import {
  getTenantByIdFromDb,
  isKnownTenantId,
  resolveTenantIdFromHost,
  tenantOverride,
  type TenantConfig,
} from "./tenants"

/**
 * Config del tenant para BRANDING (logo, nombre, credenciales de integración), no para
 * decisiones de seguridad. Lee `x-tenant-id` sin validarlo contra `isKnownTenantId()` y sin
 * fallback por host. Para autorizar un request usá `resolveRequestTenantId()`.
 */
export async function getTenantConfig(): Promise<TenantConfig> {
  const headersList = await headers()
  const tenantId = headersList.get("x-tenant-id")

  if (!tenantId) throw new Error("No x-tenant-id header — middleware may not be running")

  const config = await getTenantByIdFromDb(tenantId)
  if (!config) throw new Error(`Tenant not found: ${tenantId}`)

  return config
}

/** Mínimo común entre `Headers` (Request) y el `ReadonlyHeaders` de `next/headers`. */
interface HeaderReader {
  get(name: string): string | null
}

/**
 * Tenant del request para decisiones de SEGURIDAD.
 *
 * El HOST es la fuente de verdad: lo fija el DNS y el proxy lo valida con un 404. `x-tenant-id`
 * es un valor DERIVADO que el proxy calcula y propaga con `.set()` sobre un clon de los headers
 * entrantes — esa sobrescritura, y solo esa, es lo que lo hace confiable downstream. Poner el
 * derivado por encima del origen haría el guard bypasseable con un header en cuanto el `.set()`
 * del proxy no aplique (rutas excluidas del `matcher`, tests, self-host, invocación directa).
 *
 * Precedencia: Host → `x-tenant-id` → `TENANT_OVERRIDE` (no-prod) → `null`. Los tres primeros se
 * validan siempre con `isKnownTenantId()`: un header nunca pasa crudo. Si Host y header resuelven
 * a tenants conocidos DISTINTOS gana el Host y se loguea un warning.
 *
 * `null` = no resoluble ⇒ el llamador MUST fallar cerrado. Nunca devuelve un tenant por defecto,
 * ni el primero de `TENANT_IDS`, ni el de la sesión; `""` nunca es un tenant válido.
 *
 * Pasar el `Request` explícitamente donde esté a mano (Route Handlers): sin él cae a
 * `await headers()`, que en los tests con `next/headers` mockeado devuelve un objeto vacío.
 */
export async function resolveRequestTenantId(req?: Request): Promise<string | null> {
  const h: HeaderReader = req ? req.headers : await headers()

  // Mismo input que lee `src/proxy.ts`. `x-forwarded-host` es solo red de seguridad si `host`
  // faltara; nunca pisa a `host` (si pisara sería un header de cliente eligiendo el tenant).
  const host = h.get("host") ?? h.get("x-forwarded-host") ?? ""
  const headerTenant = h.get("x-tenant-id")?.trim() ?? ""

  const hostTenant = resolveTenantIdFromHost(host)
  if (isKnownTenantId(hostTenant)) {
    if (headerTenant && headerTenant !== hostTenant && isKnownTenantId(headerTenant)) {
      console.warn(
        `[tenant] x-tenant-id="${headerTenant}" no coincide con el host ("${hostTenant}"); gana el host`,
      )
    }
    return hostTenant
  }

  // El host no resuelve: preview (`*.vercel.app`) y destinos de rewrite. Acá el header sí decide,
  // pero solo si es un tenant conocido.
  if (isKnownTenantId(headerTenant)) return headerTenant

  const override = tenantOverride()
  if (override && isKnownTenantId(override)) return override

  return null
}
