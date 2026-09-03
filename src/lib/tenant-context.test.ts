import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// `resolveRequestTenantId()` con Requests reales, sin runtime de Next. El mock de `next/headers`
// solo existe para que el import del módulo no explote: todos los tests pasan el `Request`.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

// El registro de tenants sale de la DB (`getTenantRegistry`). Acá no hay Postgres y no es lo
// que se está testeando: cortamos el acceso para que caiga a su fallback de env
// (`TENANT_IDS` / `{PREFIX}_DOMAINS`), que es lo que estos tests configuran.
vi.mock("@/db", () => ({
  getDb: () => {
    throw new Error("sin DB en unit tests")
  },
}))

const ENV_KEYS = [
  "TENANT_IDS",
  "CENTRAL_LED_DOMAINS",
  "TEVRO_DOMAINS",
  "TENANT_OVERRIDE",
  "VERCEL_ENV",
]

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  // TENANT_IDS y DOMAIN_TO_TENANT_ID se construyen a nivel de módulo: sin reset, el primer
  // import congela el env para todo el archivo.
  vi.resetModules()
  process.env.TENANT_IDS = "central-led,tevro"
  process.env.CENTRAL_LED_DOMAINS = "crm.centralled.com.ar"
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function resolve(headers: Record<string, string>): Promise<string | null> {
  const { resolveRequestTenantId } = await import("./tenant-context")
  return resolveRequestTenantId(new Request("https://example.test/admin/inbox", { headers }))
}

describe("resolveRequestTenantId", () => {
  it("resuelve por header cuando coincide con el host", async () => {
    expect(await resolve({ host: "crm.centralled.com.ar", "x-tenant-id": "central-led" })).toBe(
      "central-led",
    )
  })

  it("sin header, dominio propio: mismo resultado que con header", async () => {
    expect(await resolve({ host: "crm.centralled.com.ar" })).toBe("central-led")
  })

  it("sin header, subdominio wildcard: primer label del host", async () => {
    expect(await resolve({ host: "tevro.vercel.app" })).toBe("tevro")
  })

  it("normaliza puerto, mayúsculas y punto final del FQDN", async () => {
    expect(await resolve({ host: "CRM.CentralLed.com.ar:3000" })).toBe("central-led")
    expect(await resolve({ host: "crm.centralled.com.ar." })).toBe("central-led")
    expect(await resolve({ host: "central-led.localhost:3000" })).toBe("central-led")
  })

  it("usa x-forwarded-host solo si falta host", async () => {
    expect(await resolve({ "x-forwarded-host": "crm.centralled.com.ar" })).toBe("central-led")
    // Y nunca pisa a `host`: si pisara, sería un header de cliente eligiendo el tenant.
    expect(await resolve({ host: "tevro.vercel.app", "x-forwarded-host": "crm.centralled.com.ar" }))
      .toBe("tevro")
  })

  it("descarta un header que no es un tenant conocido y gana el host", async () => {
    expect(
      await resolve({ host: "crm.centralled.com.ar", "x-tenant-id": "tenant-inexistente" }),
    ).toBe("central-led")
  })

  it("header falsificado a OTRO tenant conocido: gana el host y se loguea warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await resolve({ host: "crm.centralled.com.ar", "x-tenant-id": "tevro" })).toBe(
      "central-led",
    )
    expect(warn).toHaveBeenCalledOnce()
  })

  it("host no resoluble: cae al header validado (preview / rewrite)", async () => {
    expect(await resolve({ host: "crm-git-feat-x.vercel.app", "x-tenant-id": "tevro" })).toBe(
      "tevro",
    )
  })

  it("host desconocido y sin header: falla cerrado", async () => {
    expect(await resolve({ host: "atacante.example.com" })).toBeNull()
  })

  it("sin host y sin header: falla cerrado, y '' no es un tenant válido", async () => {
    expect(await resolve({})).toBeNull()
    expect(await resolve({ host: "", "x-tenant-id": "" })).toBeNull()
  })

  it("cae a TENANT_OVERRIDE cuando el host no resuelve y no hay header", async () => {
    process.env.TENANT_OVERRIDE = "central-led"
    expect(await resolve({ host: "crm-git-feat-x.vercel.app" })).toBe("central-led")
  })

  it("ignora TENANT_OVERRIDE en producción", async () => {
    process.env.VERCEL_ENV = "production"
    process.env.TENANT_OVERRIDE = "tevro"
    // Host propio: manda el host, no la override.
    expect(await resolve({ host: "crm.centralled.com.ar" })).toBe("central-led")
    // Host no resoluble: falla cerrado en vez de caer a la override.
    expect(await resolve({ host: "crm-git-feat-x.vercel.app" })).toBeNull()
  })

  it("una TENANT_OVERRIDE desconocida no se devuelve nunca", async () => {
    process.env.TENANT_OVERRIDE = "tenant-inexistente"
    expect(await resolve({ host: "crm-git-feat-x.vercel.app" })).toBeNull()
  })
})
