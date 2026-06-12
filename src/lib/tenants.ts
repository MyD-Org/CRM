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
