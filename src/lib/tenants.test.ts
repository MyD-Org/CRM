import { describe, it, expect, beforeEach, vi } from "vitest"

// Tests that tenant resolution by host works and that known tenant ids are detected.
// We set environment variables before importing the module so its module-level
// initialization picks them up (TENANT_IDS and {PREFIX}_DOMAINS).

beforeEach(() => {
  // Reset the module registry so that dynamic imports re-evaluate with new env
  vi.resetModules()
})

describe("tenant resolution", () => {
  it("resolves a tenant from a full domain listed in {PREFIX}_DOMAINS", async () => {
    process.env.TENANT_IDS = "central-led,tevro"
    process.env.CENTRAL_LED_DOMAINS = "central-led.example.com,central-led.tudominio.com"

    const tenants = await import("./tenants")

    // Domain exact match
    expect(tenants.resolveTenantIdFromHost("central-led.example.com")).toBe("central-led")
    // Subdomain label fallback: first label of host
    expect(tenants.resolveTenantIdFromHost("central-led.vercel.app")).toBe("central-led")

    expect(tenants.isKnownTenantId("central-led")).toBe(true)
    expect(tenants.isKnownTenantId("tevro")).toBe(true)
  })

  it("falls back to the first host label when domain isn't listed", async () => {
    process.env.TENANT_IDS = "central-led"
    // Ensure no specific domain mapping for the host below
    delete process.env.CENTRAL_LED_DOMAINS

    const tenants = await import("./tenants")

    expect(tenants.resolveTenantIdFromHost("crm.centralled.com.ar")).toBe("crm")
    // crm is not a known tenant id here
    expect(tenants.isKnownTenantId("crm")).toBe(false)
  })

  // La normalización vive DENTRO de resolveTenantIdFromHost para que el proxy y el guard no
  // puedan divergir (si divergieran: el proxy deja pasar, el guard expulsa → loop de redirect).
  it("normaliza el host antes de resolver", async () => {
    process.env.TENANT_IDS = "central-led"
    process.env.CENTRAL_LED_DOMAINS = " crm.centralled.com.ar , crm.otro.com "

    const { resolveTenantIdFromHost } = await import("./tenants")

    // Puerto
    expect(resolveTenantIdFromHost("crm.centralled.com.ar:3000")).toBe("central-led")
    // Mayúsculas (RFC 4343)
    expect(resolveTenantIdFromHost("CRM.CentralLed.com.ar")).toBe("central-led")
    // Punto final del FQDN
    expect(resolveTenantIdFromHost("crm.centralled.com.ar.")).toBe("central-led")
    // Espacios en la env var (segunda entrada de CENTRAL_LED_DOMAINS)
    expect(resolveTenantIdFromHost("crm.otro.com")).toBe("central-led")
    // `Host: a, b` de proxies encadenados → el primero
    expect(resolveTenantIdFromHost("crm.centralled.com.ar, interno.local")).toBe("central-led")
    // Wildcard con puerto: dev local pasa a resolver por host, sin TENANT_OVERRIDE
    expect(resolveTenantIdFromHost("central-led.localhost:3000")).toBe("central-led")
    // `localhost:3000` a secas SIGUE sin resolver: el override local no se vuelve innecesario
    expect(resolveTenantIdFromHost("localhost:3000")).toBe("localhost")
    // Host vacío → "" → nunca es un tenant conocido (fail-closed)
    expect(resolveTenantIdFromHost("")).toBe("")
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
