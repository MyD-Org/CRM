import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { seedTenant, seedOperator, truncateAll } from "./helpers"

// Autorización de la ruta de TOPES de gasto. Es el control que evita que un operador (o un
// admin del cliente) suba o baje el presupuesto de IA del tenant, así que el gate de
// superadmin tiene que estar en la ruta y no solo en la UI.
//
// Se mockea la sesión y el cliente de la ai-api; el gate que se prueba es el real.

let session: Record<string, unknown>

vi.mock("next/headers", () => ({ cookies: async () => ({}) }))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))
vi.mock("@/lib/inbox-api", () => ({
  getLimits: async () => ({ messages_per_day: 500 }),
  setLimits: async (_u: string, _t: string, patch: Record<string, unknown>) => patch,
}))
// El flag se da por encendido: lo que se prueba acá es el gate de rol, no el mecanismo de
// feature flags (y @vercel/flags no resuelve next/headers en el entorno de test).
vi.mock("@/lib/flags", () => ({ botUsagePanelEnabled: async () => true }))

const { GET: getLimitsRoute, PATCH: patchLimitsRoute } = await import(
  "@/app/api/admin/inbox/limits/route"
)

const TENANT = "test-tenant"

function loginAs(userId: string, role: "operator" | "admin" | "superadmin") {
  session = { userId, role, tenantId: TENANT, name: "Test", email: "t@x.com", save: async () => {} }
}

function patchLimits(body: unknown) {
  return patchLimitsRoute(
    new NextRequest("http://localhost/api/admin/inbox/limits", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  )
}

describe("permisos en la ruta de topes de gasto", () => {
  let operador: string
  let admin: string
  let superadmin: string

  beforeEach(async () => {
    await truncateAll()
    await seedTenant(TENANT)
    operador = await seedOperator(TENANT, { role: "operator" })
    admin = await seedOperator(TENANT, { role: "admin" })
    superadmin = await seedOperator(TENANT, { role: "superadmin" })
  })

  it("el operador no puede leer los topes", async () => {
    loginAs(operador, "operator")
    expect((await getLimitsRoute()).status).toBe(403)
  })

  it("el admin tampoco: el gasto es info de plataforma", async () => {
    loginAs(admin, "admin")
    expect((await getLimitsRoute()).status).toBe(403)
  })

  it("el operador NO puede cambiar los topes", async () => {
    loginAs(operador, "operator")
    expect((await patchLimits({ tokens_per_month: 1 })).status).toBe(403)
  })

  it("el admin NO puede cambiar los topes", async () => {
    loginAs(admin, "admin")
    expect((await patchLimits({ tokens_per_month: 1 })).status).toBe(403)
  })

  it("el superadmin sí puede cambiar los topes", async () => {
    loginAs(superadmin, "superadmin")
    const res = await patchLimits({ tokens_per_month: 2_000_000 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tokens_per_month: 2_000_000 })
  })

  it("rechaza un tope inválido (0) aunque sea superadmin", async () => {
    loginAs(superadmin, "superadmin")
    expect((await patchLimits({ tokens_per_month: 0 })).status).toBe(400)
  })
})
