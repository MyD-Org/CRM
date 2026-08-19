import { headers } from "next/headers"
import {
  getTenantByIdFromDb,
  isKnownTenantId,
  resolveTenantIdFromHost,
  tenantOverride,
  type TenantConfig,
} from "./tenants"

/**
 * Tenant del request para decisiones de SEGURIDAD.
 *
 * El HOST es la fuente de verdad. `x-tenant-id` es un valor DERIVADO que el proxy
 * calcula y propaga con `.set()` sobre un clon de los headers entrantes (ver
 * `src/proxy.ts`) — esa sobrescritura, y solo esa, es lo que lo hace confiable
 * downstream. Por eso el header solo se usa cuando el host NO resuelve (preview
 * en `*.vercel.app`, destinos de rewrite), y siempre validado con `isKnownTenantId`.
 *
 * Precedencia: Host → `x-tenant-id` → `TENANT_OVERRIDE` (nunca en producción) → null.
 * Si host y header resuelven a tenants conocidos DISTINTOS: gana el host y se loguea.
 *
 * `null` significa "no resoluble": el llamador MUST fallar cerrado (401/404). Nunca
 * se devuelve un tenant por defecto, ni el primero de `TENANT_IDS`, ni el de la sesión.
 *
 * Pasarle el `Request` explícitamente donde esté a mano (Route Handlers): sin él cae
 * a `await headers()`, que fuera del runtime de Next —o con `next/headers` mockeado—
 * no trae el host y el tenant sale `null`.
 */
export async function resolveRequestTenantId(req?: Request): Promise<string | null> {
  const h: { get(name: string): string | null } = req ? req.headers : await headers()

  // `x-forwarded-host` es solo red de seguridad si faltara `host`; nunca lo pisa —
  // si lo pisara, sería un header del cliente eligiendo el tenant.
  const host = h.get("host") ?? h.get("x-forwarded-host") ?? ""
  const hostTenant = resolveTenantIdFromHost(host)
  const headerTenant = h.get("x-tenant-id") ?? ""

  if (isKnownTenantId(hostTenant)) {
    if (headerTenant && headerTenant !== hostTenant && isKnownTenantId(headerTenant)) {
      console.warn(
        `resolveRequestTenantId: x-tenant-id="${headerTenant}" difiere del host ("${hostTenant}"); gana el host`,
      )
    }
    return hostTenant
  }

  if (isKnownTenantId(headerTenant)) return headerTenant

  const override = tenantOverride()
  if (override && isKnownTenantId(override)) return override

  return null
}

/**
 * Config de BRANDING del tenant (nombre, logo, credenciales de integraciones).
 * NO es un control de seguridad: lee `x-tenant-id` sin fallback por host ni
 * validación contra `TENANT_IDS`. Para autorización usar `resolveRequestTenantId()`.
 */
export async function getTenantConfig(): Promise<TenantConfig> {
  const headersList = await headers()
  const tenantId = headersList.get("x-tenant-id")

  if (!tenantId) throw new Error("No x-tenant-id header — middleware may not be running")

  const config = await getTenantByIdFromDb(tenantId)
  if (!config) throw new Error(`Tenant not found: ${tenantId}`)

  return config
}
