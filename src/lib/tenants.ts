export interface TenantConfig {
  id: string
  name: string
  subtitle: string
  logoPath: string
  flexxusBaseUrl: string
  flexxusToken: string
  flexxusMock: boolean
  whatsappNumber: string
  resendFrom: string
  aiApiBaseUrl: string
  aiApiKey: string
  aiAgentId: string
  aiTenantId: string // UUID del tenant en la ai-api (para auth de staff/inbox)
}

function buildTenantConfig(id: string): TenantConfig | null {
  const prefix = id.toUpperCase().replace(/-/g, "_")
  const flexxusUrl = process.env[`${prefix}_FLEXXUS_URL`] ?? ""
  const isMock = process.env[`${prefix}_MOCK`] === "true"

  if (!flexxusUrl && !isMock) return null

  return {
    id,
    name: process.env[`${prefix}_NAME`] ?? id,
    subtitle: process.env[`${prefix}_SUBTITLE`] ?? "",
    logoPath: process.env[`${prefix}_LOGO`] ?? `/logos/${id}.svg`,
    flexxusBaseUrl: flexxusUrl,
    flexxusToken: process.env[`${prefix}_FLEXXUS_TOKEN`] ?? "",
    flexxusMock: isMock,
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

export function getTenantById(id: string): TenantConfig | null {
  return tenants.get(id) ?? null
}

/** IDs de tenants activos — usado por el middleware (Edge, sin acceso a DB) */
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
      flexxusBaseUrl: row.flexxusBaseUrl,
      flexxusToken: row.flexxusToken,
      flexxusMock: row.flexxusMock,
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
