import { describe, it, expect, beforeEach, vi } from "vitest"

// Unit del ORDEN de verificación y del contrato de la unión discriminada. Los casos con datos
// reales (usuario borrado, movido de tenant, rol cambiado) viven en los tests de integración;
// acá interesa que el guard falle cerrado y que el paso barato corte antes del caro.

type Row = {
  id: string
  name: string
  email: string
  role: string
  availability: string
  tenantId: string
  passwordHash: string | null
}

const state = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  rows: [] as unknown[],
  selectCalls: 0,
  requestTenantId: null as string | null,
}))

vi.mock("next/headers", () => ({ cookies: async () => ({}) }))

vi.mock("iron-session", () => ({
  getIronSession: async () => state.session,
}))

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => {
      state.selectCalls++
      return { from: () => ({ where: () => Promise.resolve(state.rows) }) }
    },
  }),
}))

vi.mock("@/lib/tenant-context", () => ({
  resolveRequestTenantId: async () => state.requestTenantId,
}))

const ROW: Row = {
  id: "u1",
  name: "Ana",
  email: "ana@ejemplo.com",
  role: "operator",
  availability: "available",
  tenantId: "tenant-a",
  passwordHash: "hash",
}

beforeEach(() => {
  state.session = { userId: "u1", name: "Ana", email: "ana@ejemplo.com", role: "admin", tenantId: "tenant-a" }
  state.rows = [ROW]
  state.selectCalls = 0
  state.requestTenantId = "tenant-a"
})

async function guard() {
  const { getGuardedAdminSession } = await import("./admin-session")
  return getGuardedAdminSession(new Request("https://tenant-a.test/admin/inbox"))
}

describe("getGuardedAdminSession", () => {
  it("acepta una sesión coherente y devuelve el rol de la DB, no el de la cookie", async () => {
    const result = await guard()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tenantId).toBe("tenant-a")
    // La cookie dice "admin"; la fila dice "operator". Manda la fila.
    expect(result.user.role).toBe("operator")
    expect(result.user.availability).toBe("available")
  })

  it("sin sesión: rechaza sin consultar admin_users", async () => {
    state.session = {}

    const result = await guard()

    expect(result).toEqual({ ok: false, reason: "no-session" })
    expect(state.selectCalls).toBe(0)
  })

  it("tenant del request no resoluble: falla cerrado sin consultar admin_users", async () => {
    state.requestTenantId = null

    const result = await guard()

    expect(result).toEqual({ ok: false, reason: "no-tenant" })
    expect(state.selectCalls).toBe(0)
  })

  it("cookie de un tenant + host de otro: corta ANTES de la DB", async () => {
    state.requestTenantId = "tenant-b"

    const result = await guard()

    expect(result).toEqual({ ok: false, reason: "tenant-mismatch" })
    expect(state.selectCalls).toBe(0)
  })

  it("usuario borrado: user-gone", async () => {
    state.rows = []

    expect(await guard()).toEqual({ ok: false, reason: "user-gone" })
  })

  it("usuario movido de tenant: tenant-mismatch aunque la cookie coincida con el host", async () => {
    state.rows = [{ ...ROW, tenantId: "tenant-b" }]

    expect(await guard()).toEqual({ ok: false, reason: "tenant-mismatch" })
  })

  it("cuenta sin contraseña (invitación pendiente o desactivada): inactive", async () => {
    state.rows = [{ ...ROW, passwordHash: null }]

    expect(await guard()).toEqual({ ok: false, reason: "inactive" })
  })

  it("un solo select en el camino feliz: sin round-trips nuevos", async () => {
    await guard()

    expect(state.selectCalls).toBe(1)
  })
})
