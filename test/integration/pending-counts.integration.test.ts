import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { listConversations } from "@/lib/inbox-api"
import { seedOperator, seedTenant, truncateAll } from "./helpers"
import { seedReceipt } from "./fake-r2"

// Tests de integración de GET /api/admin/pending-counts (badges del sidebar del backoffice).
// La DB es real (crm_test); se mockean iron-session/next-headers (sesión admin) y
// @/lib/inbox-api (listConversations, que es la llamada a la ai-api). Nada de datos reales.

let session: Record<string, unknown>

vi.mock("next/headers", () => ({
  cookies: async () => ({}),
  headers: async () => new Headers({ "x-tenant-id": "tenant-a" }),
}))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))
vi.mock("@/lib/inbox-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbox-api")>()),
  listConversations: vi.fn(),
}))

const { GET: pendingCountsRoute, clearPendingCountsCache } = await import(
  "@/app/api/admin/pending-counts/route"
)

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"

function login(userId: string, opts: { tenantId?: string } = {}) {
  session = {
    userId,
    role: "admin",
    tenantId: opts.tenantId ?? TENANT_A,
    name: "Ana Admin",
    email: "ana.admin@example.com",
    save: async () => {},
  }
}
function logout() {
  session = {}
}

const req = (host?: string) =>
  new NextRequest(`http://${host ?? TENANT_A}.localhost/api/admin/pending-counts`, {
    headers: { host: `${host ?? TENANT_A}.localhost` },
  })

const CONVERSACIONES = [
  { id: "c1", awaiting_reply: true },
  { id: "c2", awaiting_reply: true },
  { id: "c3", awaiting_reply: false },
]

let adminA: string
let operatorA: string

describe("admin: pending-counts (badges del sidebar)", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    clearPendingCountsCache()
    await truncateAll()
    await seedTenant(TENANT_A, { receiptsEmail: "pagos@example.com" })
    await seedTenant(TENANT_B, { receiptsEmail: "pagos-b@example.com" })
    adminA = await seedOperator(TENANT_A, { role: "admin", name: "Ana Admin", email: "ana.admin@example.com" })
    operatorA = await seedOperator(TENANT_A, { role: "operator", name: "Ope Rador", email: "ope.admin@example.com" })
    invalidateTenantRegistry()
    vi.mocked(listConversations).mockResolvedValue(CONVERSACIONES as never)
    login(adminA)
  })

  afterAll(async () => {
    await truncateAll()
  })

  it("sin sesión ⇒ 401", async () => {
    logout()
    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("unauthorized")
    expect(listConversations).not.toHaveBeenCalled()
  })

  it("admin ⇒ inbox = conversaciones awaiting_reply, comprobantes = pending del tenant", async () => {
    await seedReceipt(TENANT_A, "416") // pending
    await seedReceipt(TENANT_A, "416") // pending
    await seedReceipt(TENANT_A, "416", { status: "loaded" }) // no cuenta
    await seedReceipt(TENANT_B, "999") // otro tenant: no cuenta

    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ inbox: 2, comprobantes: 2 })
  })

  it("operador ⇒ comprobantes en null (no se expone el dato)", async () => {
    await seedReceipt(TENANT_A, "416")
    login(operatorA)

    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ inbox: 2, comprobantes: null })
  })

  it("tenant sin inbox configurado ⇒ inbox 0 (no es error)", async () => {
    await getDb().update(tenants).set({ aiApiUrl: "", aiTenantId: "" }).where(eq(tenants.id, TENANT_A))

    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ inbox: 0, comprobantes: 0 })
    expect(listConversations).not.toHaveBeenCalled()
  })

  it("ai-api caída ⇒ 502 y el cliente mantiene lo último conocido", async () => {
    vi.mocked(listConversations).mockRejectedValueOnce(new Error("ai-api caida"))

    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe("counts_error")
  })

  it("aislamiento: el count de A no incluye los pendientes de B", async () => {
    await seedReceipt(TENANT_A, "416")
    await seedReceipt(TENANT_B, "999")
    await seedReceipt(TENANT_B, "999")

    const resA = await pendingCountsRoute(req(TENANT_A))
    expect((await resA.json()).comprobantes).toBe(1)

    const adminB = await seedOperator(TENANT_B, { role: "superadmin", name: "Bee Admin", email: "admin.b@example.com" })
    login(adminB, { tenantId: TENANT_B })
    const resB = await pendingCountsRoute(req(TENANT_B))
    expect((await resB.json()).comprobantes).toBe(2)
  })

  it("cache: dos consultas seguidas del mismo tenant pegan una sola vez a la ai-api", async () => {
    await pendingCountsRoute(req())
    await pendingCountsRoute(req())

    expect(listConversations).toHaveBeenCalledTimes(1)
    // El clear entre tests lo garantiza el beforeEach; acá el TTL aún no venció.
    clearPendingCountsCache()
    await pendingCountsRoute(req())
    expect(listConversations).toHaveBeenCalledTimes(2)
  })
})
