export interface TenantConfig {
  id: string
  name: string
  subtitle: string
  logoPath: string
  alegraEmail: string
  alegraToken: string
  alegraMock: boolean
  whatsappNumber: string
  resendFrom: string
  aiApiBaseUrl: string
  aiApiKey: string
  aiAgentId: string
  aiTenantId: string // UUID del tenant en la ai-api (para auth de staff/inbox)
}

function buildTenantConfig(id: string): TenantConfig | null {
  const prefix = id.toUpperCase().replace(/-/g, "_")
  const isMock = process.env[`${prefix}_MOCK`] === "true"
  const hasAlegra = Boolean(process.env[`${prefix}_ALEGRA_TOKEN`])

  // Alegra es el ERP del portal. Un tenant es válido en modo mock (fixtures de dev) o con
  // credenciales reales de Alegra.
  if (!isMock && !hasAlegra) return null

  return {
    id,
    name: process.env[`${prefix}_NAME`] ?? id,
    subtitle: process.env[`${prefix}_SUBTITLE`] ?? "",
    logoPath: process.env[`${prefix}_LOGO`] ?? `/logos/${id}.svg`,
    alegraEmail: process.env[`${prefix}_ALEGRA_EMAIL`] ?? "",
    alegraToken: process.env[`${prefix}_ALEGRA_TOKEN`] ?? "",
    // Sin credenciales de Alegra → el portal corre en mock (fixtures). Setear el token real lo apaga.
    alegraMock: process.env[`${prefix}_ALEGRA_MOCK`] === "true" || (isMock && !hasAlegra),
    whatsappNumber: process.env[`${prefix}_WHATSAPP`] ?? "",
    resendFrom: process.env[`${prefix}_RESEND_FROM`] ?? "portal@example.com",
    aiApiBaseUrl: process.env[`${prefix}_AI_API_URL`] ?? "",
    aiApiKey: process.env[`${prefix}_AI_API_KEY`] ?? "",
    aiAgentId: process.env[`${prefix}_AI_AGENT_ID`] ?? "",
    aiTenantId: process.env[`${prefix}_AI_TENANT_ID`] ?? "",
  }
}

const TENANT_IDS = (process.env.TENANT_IDS ?? "central-led").split(",").map((s) => s.trim())

export const tenants: Map<string, TenantConfig> = new Map(
  TENANT_IDS.map((id) => [id, buildTenantConfig(id)] as [string, TenantConfig | null]).filter(
    (entry): entry is [string, TenantConfig] => entry[1] !== null,
  ),
)

// El tenant se resuelve por el PRIMER label del host (ver proxy.ts): "central-led.vercel.app"
// → id "central-led". Un dominio propio como "crm.centralled.com.ar" no matchea ningún id así
// (el label es "crm"), así que cada tenant puede declarar el/los host(s) completos donde vive
// bajo su propio dominio — `{PREFIX}_DOMAINS`, coma-separado (ej. "crm.centralled.com.ar").
// Se resuelve por host COMPLETO, no por label, para no pisar si dos tenants comparten dominio.
const DOMAIN_TO_TENANT_ID: Map<string, string> = new Map(
  TENANT_IDS.flatMap((id) => {
    const prefix = id.toUpperCase().replace(/-/g, "_")
    const domains = (process.env[`${prefix}_DOMAINS`] ?? "")
      .split(",")
      .map((d) => normalizeHost(d))
      .filter(Boolean)
    return domains.map((domain) => [domain, id] as [string, string])
  }),
)

/**
 * Normaliza un header Host (o una entrada de `{PREFIX}_DOMAINS`) a una clave comparable.
 *
 * Vive acá a propósito: la usan `resolveTenantIdFromHost()` (proxy) y, por transitividad,
 * `resolveRequestTenantId()` (guard). Si el proxy normalizara distinto que el guard el usuario
 * queda en loop de redirect — el proxy lo deja pasar y el guard lo expulsa —, un modo de falla
 * que parece caída de servicio. Un solo lugar donde un string de host se vuelve un id.
 */
function normalizeHost(hostHeader: string): string {
  return (hostHeader ?? "")
    .split(",")[0] // `Host: a, b` con proxies encadenados → el primero
    .trim()
    .toLowerCase() // hostnames son case-insensitive (RFC 4343)
    .replace(/:\d+$/, "") // `localhost:3000`, `central-led.localhost:3000`. Exige dígitos → no rompe `[::1]`
    .replace(/\.$/, "") // FQDN con root explícito: `example.com.`
}

/** Resuelve el id de tenant a partir del host del request (dominio propio o *.subdominio). */
export function resolveTenantIdFromHost(host: string): string {
  const normalized = normalizeHost(host)
  return DOMAIN_TO_TENANT_ID.get(normalized) ?? normalized.split(".")[0] ?? ""
}

/**
 * `TENANT_OVERRIDE`, o `undefined` en producción.
 *
 * La override existe para los previews (`*.vercel.app`, cuyo primer label no matchea ningún
 * tenant: sin ella todo responde 404) y para `localhost:3000` en dev. En producción vuelve no-op
 * cualquier guard host↔sesión, así que se neutraliza **en código** — que alguien la re-agregue a
 * Production en Vercel no debe reabrir el agujero.
 *
 * `|| undefined`, no `??`: un `TENANT_OVERRIDE=""` (seteada pero vacía, como quedó una vez en
 * prod) no debe pisar la resolución por host. `??` solo cae al fallback con null/undefined, así
 * que un string vacío rompía TODAS las requests con 404.
 */
export function tenantOverride(): string | undefined {
  if (process.env.VERCEL_ENV === "production") return undefined
  return process.env.TENANT_OVERRIDE || undefined
}

export function getTenantById(id: string): TenantConfig | null {
  return tenants.get(id) ?? null
}

/** IDs de tenants activos — usado por el proxy (Edge, sin acceso a DB) */
export function isKnownTenantId(id: string): boolean {
  return TENANT_IDS.includes(id)
}

/**
 * Config del tenant desde la DB, con fallback transitorio al registro de env.
 * El fallback se elimina cuando la DB esté estabilizada en todos los entornos.
 */
export async function getTenantByIdFromDb(id: string): Promise<TenantConfig | null> {
  try {
    const { getDb } = await import("@/db")
    const { tenants: tenantsTable } = await import("@/db/schema")
    const { eq } = await import("drizzle-orm")

    const [row] = await getDb().select().from(tenantsTable).where(eq(tenantsTable.id, id))
    if (!row) return getTenantById(id)

    return {
      id: row.id,
      name: row.name,
      subtitle: row.subtitle,
      logoPath: row.logoPath,
      alegraEmail: row.alegraEmail,
      alegraToken: row.alegraToken,
      alegraMock: row.alegraMock,
      whatsappNumber: row.whatsappNumber,
      resendFrom: row.resendFrom,
      aiApiBaseUrl: row.aiApiUrl,
      aiApiKey: row.aiApiKey,
      aiAgentId: row.aiAgentId,
      aiTenantId: row.aiTenantId,
    }
  } catch (err) {
    console.error("getTenantByIdFromDb: DB no disponible, fallback a env:", err)
    return getTenantById(id)
  }
}
