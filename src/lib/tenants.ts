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

/**
 * Lista de arranque, desde env. Es el FALLBACK: la fuente de verdad es la tabla `tenants`
 * (ver `getTenantRegistry`). Sigue existiendo para que el proxy pueda responder aunque la DB
 * esté caída o todavía no exista (tests, `next build`, primer deploy de un entorno nuevo).
 */
const TENANT_IDS = (process.env.TENANT_IDS ?? "central-led").split(",").map((s) => s.trim()).filter(Boolean)

export const tenants: Map<string, TenantConfig> = new Map(
  TENANT_IDS.map((id) => [id, buildTenantConfig(id)] as [string, TenantConfig | null]).filter(
    (entry): entry is [string, TenantConfig] => entry[1] !== null,
  ),
)

/**
 * El tenant se resuelve por el PRIMER label del host: `avantec.tevro.com.ar` → id `avantec`.
 * Ese es el caso normal de la plataforma y no necesita configuración: alta = fila nueva.
 *
 * Un dominio PROPIO como `crm.centralled.com.ar` no matchea ningún id así (el label es "crm"),
 * así que cada tenant puede declarar el/los host(s) completos donde vive — columna `domains`,
 * coma-separada, con `{PREFIX}_DOMAINS` como fallback de env. Se resuelve por host COMPLETO,
 * no por label, para no pisar si dos tenants comparten dominio.
 */
export interface TenantRegistry {
  /** Ids de tenants activos. */
  ids: Set<string>
  /** host completo normalizado → id de tenant. Solo dominios propios. */
  domains: Map<string, string>
}

function envRegistry(): TenantRegistry {
  const domains = new Map<string, string>()
  for (const id of TENANT_IDS) {
    const prefix = id.toUpperCase().replace(/-/g, "_")
    for (const raw of (process.env[`${prefix}_DOMAINS`] ?? "").split(",")) {
      const host = normalizeHost(raw)
      if (host) domains.set(host, id)
    }
  }
  return { ids: new Set(TENANT_IDS), domains }
}

// El proxy corre en Node runtime (Next 16) y se ejecuta en CADA request: sin cache esto sería
// una query por request. TTL corto porque el alta de un tenant tiene que verse "ya" — un
// minuto de espera es aceptable, un redeploy no.
const REGISTRY_TTL_MS = 60_000
let registryCache: { at: number; value: TenantRegistry } | null = null

/**
 * Registro de tenants: ids + dominios propios.
 *
 * Los IDS son autoritativos desde la DB (borrar una fila da de baja al tenant). Los DOMINIOS
 * son la unión de env + DB, con la DB ganando: perder un mapeo de host tira abajo un tenant
 * vivo, así que ahí se suma en vez de reemplazar.
 *
 * FALLA ABIERTO hacia el último valor bueno y, si nunca hubo uno, hacia env. Un blip de la DB
 * no puede volver 404 a toda la plataforma; y una tabla vacía (DB recién creada, apuntando al
 * entorno equivocado) tampoco, porque sería el mismo apagón con otra cara.
 */
export async function getTenantRegistry(): Promise<TenantRegistry> {
  const now = Date.now()
  if (registryCache && now - registryCache.at < REGISTRY_TTL_MS) return registryCache.value

  try {
    const { getDb } = await import("@/db")
    const { tenants: tenantsTable } = await import("@/db/schema")

    const rows = await getDb()
      .select({ id: tenantsTable.id, domains: tenantsTable.domains })
      .from(tenantsTable)

    if (rows.length === 0) throw new Error("la tabla `tenants` está vacía")

    const ids = new Set<string>()
    // Los dominios de env son el PISO, no un reemplazo: la DB se suma encima (y gana ante un
    // mismo host). Si la DB fuera la única fuente, un tenant con `{PREFIX}_DOMAINS` seteada y
    // la columna `domains` todavía vacía perdería su dominio propio en el primer deploy —
    // `crm.centralled.com.ar` pasaría a resolver a "crm" y daría 404. La unión hace que migrar
    // el dato de env a la columna sea un paso opcional y sin ventana de caída.
    const domains = envRegistry().domains
    for (const row of rows) {
      ids.add(row.id)
      for (const raw of (row.domains ?? "").split(",")) {
        const host = normalizeHost(raw)
        if (host) domains.set(host, row.id)
      }
    }

    const value: TenantRegistry = { ids, domains }
    registryCache = { at: now, value }
    return value
  } catch (err) {
    console.error("getTenantRegistry: DB no disponible, fallback:", err)
    // Servir el último valor bueno vencido antes que degradar a env: es más nuevo.
    if (registryCache) return registryCache.value
    return envRegistry()
  }
}

/** Invalida el cache del registro. Para usar después de dar de alta o borrar un tenant. */
export function invalidateTenantRegistry(): void {
  registryCache = null
}

/**
 * Normaliza un header Host (o una entrada de `domains`) a una clave comparable.
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
export async function resolveTenantIdFromHost(host: string): Promise<string> {
  const normalized = normalizeHost(host)
  const { domains } = await getTenantRegistry()
  return domains.get(normalized) ?? normalized.split(".")[0] ?? ""
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

/**
 * ¿Es `id` un tenant activo? Lo consultan el proxy (404 si no) y el guard de `/admin`.
 *
 * Sale del registro cacheado, no de `TENANT_IDS`: dar de alta una empresa es un INSERT y su
 * `empresa.tevro.com.ar` empieza a responder dentro del TTL, sin redeploy.
 */
export async function isKnownTenantId(id: string): Promise<boolean> {
  if (!id) return false // `""` nunca es un tenant válido (fail-closed)
  const { ids } = await getTenantRegistry()
  return ids.has(id)
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
