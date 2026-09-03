import { describe, it, expect, beforeEach, vi } from "vitest"

// La resolución de tenant sale del REGISTRO (`getTenantRegistry`): ids + dominios propios
// desde la tabla `tenants`, con las env vars (`TENANT_IDS`, `{PREFIX}_DOMAINS`) como fallback.
// Estos tests son unitarios y no tocan Postgres: mockeamos `@/db` para elegir explícitamente
// qué devuelve la DB, incluido "explota" (que es el caso de fallback a env).

const dbRows = vi.hoisted(() => ({ value: null as null | { id: string; domains: string }[] }))

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => ({
      from: async () => {
        if (dbRows.value === null) throw new Error("DB no disponible (simulado)")
        return dbRows.value
      },
    }),
  }),
}))

beforeEach(() => {
  // Resetear el registro de módulos: `TENANT_IDS` y el cache del registro se evalúan al importar.
  vi.resetModules()
  dbRows.value = null // por defecto, sin DB → fallback a env
})

describe("resolución de tenant desde env (DB caída)", () => {
  it("resuelve un tenant por un dominio completo de {PREFIX}_DOMAINS", async () => {
    process.env.TENANT_IDS = "central-led,tevro"
    process.env.CENTRAL_LED_DOMAINS = "central-led.example.com,central-led.tudominio.com"

    const tenants = await import("./tenants")

    // Match exacto de dominio propio
    await expect(tenants.resolveTenantIdFromHost("central-led.example.com")).resolves.toBe("central-led")
    // Fallback al primer label del host
    await expect(tenants.resolveTenantIdFromHost("central-led.vercel.app")).resolves.toBe("central-led")

    await expect(tenants.isKnownTenantId("central-led")).resolves.toBe(true)
    await expect(tenants.isKnownTenantId("tevro")).resolves.toBe(true)
  })

  it("cae al primer label del host cuando el dominio no está declarado", async () => {
    process.env.TENANT_IDS = "central-led"
    delete process.env.CENTRAL_LED_DOMAINS

    const tenants = await import("./tenants")

    await expect(tenants.resolveTenantIdFromHost("crm.centralled.com.ar")).resolves.toBe("crm")
    // "crm" no es un tenant conocido acá
    await expect(tenants.isKnownTenantId("crm")).resolves.toBe(false)
  })

  // La normalización vive DENTRO de resolveTenantIdFromHost para que el proxy y el guard no
  // puedan divergir (si divergieran: el proxy deja pasar, el guard expulsa → loop de redirect).
  it("normaliza el host antes de resolver", async () => {
    process.env.TENANT_IDS = "central-led"
    process.env.CENTRAL_LED_DOMAINS = " crm.centralled.com.ar , crm.otro.com "

    const { resolveTenantIdFromHost } = await import("./tenants")

    // Puerto
    await expect(resolveTenantIdFromHost("crm.centralled.com.ar:3000")).resolves.toBe("central-led")
    // Mayúsculas (RFC 4343)
    await expect(resolveTenantIdFromHost("CRM.CentralLed.com.ar")).resolves.toBe("central-led")
    // Punto final del FQDN
    await expect(resolveTenantIdFromHost("crm.centralled.com.ar.")).resolves.toBe("central-led")
    // Espacios en la env var (segunda entrada de CENTRAL_LED_DOMAINS)
    await expect(resolveTenantIdFromHost("crm.otro.com")).resolves.toBe("central-led")
    // `Host: a, b` de proxies encadenados → el primero
    await expect(resolveTenantIdFromHost("crm.centralled.com.ar, interno.local")).resolves.toBe("central-led")
    // Wildcard con puerto: dev local pasa a resolver por host, sin TENANT_OVERRIDE
    await expect(resolveTenantIdFromHost("central-led.localhost:3000")).resolves.toBe("central-led")
    // `localhost:3000` a secas SIGUE sin resolver: el override local no se vuelve innecesario
    await expect(resolveTenantIdFromHost("localhost:3000")).resolves.toBe("localhost")
    // Host vacío → "" → nunca es un tenant conocido (fail-closed)
    await expect(resolveTenantIdFromHost("")).resolves.toBe("")
  })
})

describe("resolución de tenant desde la DB", () => {
  // El punto de todo el cambio: dar de alta una empresa es un INSERT, no un redeploy. El id
  // NO está en TENANT_IDS y aun así `empresa.tevro.com.ar` tiene que responder.
  it("reconoce un tenant que existe en la DB pero no en TENANT_IDS", async () => {
    process.env.TENANT_IDS = "central-led"
    dbRows.value = [
      { id: "central-led", domains: "crm.centralled.com.ar" },
      { id: "avantec", domains: "" },
    ]

    const tenants = await import("./tenants")

    await expect(tenants.resolveTenantIdFromHost("avantec.tevro.com.ar")).resolves.toBe("avantec")
    await expect(tenants.isKnownTenantId("avantec")).resolves.toBe(true)
    // Y el dominio propio del otro tenant sigue resolviendo, ahora desde la columna `domains`
    await expect(tenants.resolveTenantIdFromHost("crm.centralled.com.ar")).resolves.toBe("central-led")
  })

  // El deploy que estrenó la columna `domains` la encontró VACÍA en prod, con los dominios
  // propios todavía en env. Si la DB reemplazara a env en vez de sumarse, ese deploy dejaba a
  // `crm.centralled.com.ar` resolviendo a "crm" → 404 para un tenant vivo.
  it("los dominios de env sobreviven aunque la columna `domains` esté vacía", async () => {
    process.env.TENANT_IDS = "central-led"
    process.env.CENTRAL_LED_DOMAINS = "crm.centralled.com.ar"
    dbRows.value = [
      { id: "central-led", domains: "" },
      { id: "avantec", domains: "" },
    ]

    const { resolveTenantIdFromHost } = await import("./tenants")

    await expect(resolveTenantIdFromHost("crm.centralled.com.ar")).resolves.toBe("central-led")
  })

  it("la columna `domains` gana sobre la env var para el mismo host", async () => {
    process.env.TENANT_IDS = "central-led,avantec"
    process.env.CENTRAL_LED_DOMAINS = "compartido.example.com"
    dbRows.value = [
      { id: "central-led", domains: "" },
      { id: "avantec", domains: "compartido.example.com" },
    ]

    const { resolveTenantIdFromHost } = await import("./tenants")

    await expect(resolveTenantIdFromHost("compartido.example.com")).resolves.toBe("avantec")
  })

  it("un tenant borrado de la DB deja de ser conocido aunque siga en TENANT_IDS", async () => {
    process.env.TENANT_IDS = "central-led,tevro"
    dbRows.value = [{ id: "central-led", domains: "" }]

    const { isKnownTenantId } = await import("./tenants")

    await expect(isKnownTenantId("central-led")).resolves.toBe(true)
    await expect(isKnownTenantId("tevro")).resolves.toBe(false)
  })

  // Una tabla vacía casi siempre significa "apuntando a la DB equivocada", no "no hay clientes".
  // Tratarla como verdad apagaría la plataforma entera con 404.
  it("una tabla vacía no apaga la plataforma: cae a env", async () => {
    process.env.TENANT_IDS = "central-led"
    dbRows.value = []

    const { isKnownTenantId } = await import("./tenants")

    await expect(isKnownTenantId("central-led")).resolves.toBe(true)
  })

  it("cachea el registro y lo suelta con invalidateTenantRegistry", async () => {
    process.env.TENANT_IDS = "central-led"
    dbRows.value = [{ id: "central-led", domains: "" }]

    const { isKnownTenantId, invalidateTenantRegistry } = await import("./tenants")
    await expect(isKnownTenantId("central-led")).resolves.toBe(true)

    // Alta nueva en la DB: sin invalidar, el cache todavía no la ve.
    dbRows.value = [{ id: "central-led", domains: "" }, { id: "avantec", domains: "" }]
    await expect(isKnownTenantId("avantec")).resolves.toBe(false)

    invalidateTenantRegistry()
    await expect(isKnownTenantId("avantec")).resolves.toBe(true)
  })
})

describe("tenantOverride", () => {
  beforeEach(() => {
    delete process.env.VERCEL_ENV
    delete process.env.TENANT_OVERRIDE
  })

  it("devuelve undefined en producción aunque la variable esté seteada", async () => {
    process.env.VERCEL_ENV = "production"
    process.env.TENANT_OVERRIDE = "otro-tenant"

    const { tenantOverride } = await import("./tenants")

    expect(tenantOverride()).toBeUndefined()
  })

  it("sigue aplicando en preview y en local (VERCEL_ENV ausente)", async () => {
    process.env.TENANT_OVERRIDE = "central-led"

    process.env.VERCEL_ENV = "preview"
    let mod = await import("./tenants")
    expect(mod.tenantOverride()).toBe("central-led")

    delete process.env.VERCEL_ENV
    vi.resetModules()
    mod = await import("./tenants")
    expect(mod.tenantOverride()).toBe("central-led")
  })

  it("una override vacía no pisa la resolución por host (regresión ya arreglada)", async () => {
    process.env.TENANT_OVERRIDE = ""

    const { tenantOverride } = await import("./tenants")

    expect(tenantOverride()).toBeUndefined()
  })
})
