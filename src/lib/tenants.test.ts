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
})
