import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { listConversations, type InboxConversation } from "@/lib/inbox-api"
import { seedOperator, seedTenant, truncateAll } from "./helpers"
import { seedReceipt } from "./fake-r2"

// Tests de integración de GET /api/admin/pending-counts (badges de "novedades" del sidebar).
// Modelo: items nuevos desde la última visita a la sección. El conteo de inbox exige
// awaiting_reply && status === "active" (el ai-api deja awaiting_reply=true en conversaciones
// cerradas: contarlas inflaba el badge). La DB es real (crm_test); se mockean iron-session,
// next/headers y @/lib/inbox-api (listConversations, la llamada a la ai-api).

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

// 2 activas esperando respuesta (una reciente, una vieja), 1 activa sin awaiting, 1 cerrada
// con awaiting_reply=true (el dato de prod que inflaba el badge), 1 activa sin last_inbound_at.
const CONVERSACIONES = [
  { id: "c1", status: "active", awaiting_reply: true, last_inbound_at: "2026-09-14T10:00:00.000Z" },
  { id: "c2", status: "active", awaiting_reply: true, last_inbound_at: "2026-09-10T10:00:00.000Z" },
  { id: "c3", status: "active", awaiting_reply: false, last_inbound_at: "2026-09-14T10:00:00.000Z" },
  { id: "c4", status: "closed", awaiting_reply: true, last_inbound_at: "2026-09-14T10:00:00.000Z" },
  { id: "c5", status: "active", awaiting_reply: true, last_inbound_at: null },
] as unknown as InboxConversation[]

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

const req = (qs = "", host?: string) =>
  new NextRequest(`http://${host ?? TENANT_A}.localhost/api/admin/pending-counts${qs}`, {
    headers: { host: `${host ?? TENANT_A}.localhost` },
  })

let adminA: string
let operatorA: string

describe("admin: pending-counts (badges de novedades)", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    clearPendingCountsCache()
    await truncateAll()
    await seedTenant(TENANT_A, { receiptsEmail: "pagos@example.com" })
    await seedTenant(TENANT_B, { receiptsEmail: "pagos-b@example.com" })
    adminA = await seedOperator(TENANT_A, { role: "admin", name: "Ana Admin", email: "ana.admin@example.com" })
    operatorA = await seedOperator(TENANT_A, { role: "operator", name: "Ope Rador", email: "ope.admin@example.com" })
    invalidateTenantRegistry()
    vi.mocked(listConversations).mockResolvedValue(CONVERSACIONES)
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

  it("sin since: solo activas con awaiting_reply (las cerradas no cuentan, aunque tengan awaiting)", async () => {
    await seedReceipt(TENANT_A, "416")
    await seedReceipt(TENANT_A, "416")
    await seedReceipt(TENANT_A, "416", { status: "loaded" }) // no cuenta
    await seedReceipt(TENANT_B, "999") // otro tenant: no cuenta

    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(200)
    // c1, c2 y c5 (activa sin last_inbound_at, sin since sí cuenta); c3 no (sin awaiting) y
    // c4 no (cerrada).
    expect(await res.json()).toEqual({ inbox: 3, comprobantes: 2 })
  })

  it("?since= filtra inbox por last_inbound_at y comprobantes por submittedAt", async () => {
    await seedReceipt(TENANT_A, "416", { submittedAt: new Date("2026-09-13T10:00:00.000Z") }) // nuevo
    await seedReceipt(TENANT_A, "416", { submittedAt: new Date("2026-09-01T10:00:00.000Z") }) // viejo

    const since = "2026-09-13T00:00:00.000Z"
    const res = await pendingCountsRoute(req(`?since=${encodeURIComponent(since)}`))
    expect(res.status).toBe(200)
    // c1 (14/09 > since) sí; c2 (10/09) no; c5 (last_inbound_at null) no cuando hay since.
    expect(await res.json()).toEqual({ inbox: 1, comprobantes: 1 })
  })

  it("parámetros por sección: sinceInbox filtra solo inbox, sinceComprobantes solo comprobantes", async () => {
    await seedReceipt(TENANT_A, "416", { submittedAt: new Date("2026-09-13T10:00:00.000Z") })
    await seedReceipt(TENANT_A, "416", { submittedAt: new Date("2026-09-01T10:00:00.000Z") })

    const qs =
      `?sinceInbox=${encodeURIComponent("2026-09-13T00:00:00.000Z")}` +
      `&sinceComprobantes=${encodeURIComponent("2026-09-01T00:00:00.000Z")}`
    const res = await pendingCountsRoute(req(qs))
    expect(res.status).toBe(200)
    // inbox filtrado por el 13 (solo c1); comprobantes con since más viejo (ambos recibos).
    expect(await res.json()).toEqual({ inbox: 1, comprobantes: 2 })
  })

  it("since inválido = sin filtro (backlog completo)", async () => {
    const res = await pendingCountsRoute(req("?since=mañana"))
    expect(res.status).toBe(200)
    expect((await res.json()).inbox).toBe(3)
  })

  it("operador ⇒ comprobantes en null (no se expone el dato)", async () => {
    await seedReceipt(TENANT_A, "416")
    login(operatorA)

    const res = await pendingCountsRoute(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ inbox: 3, comprobantes: null })
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

    const resA = await pendingCountsRoute(req("", TENANT_A))
    expect((await resA.json()).comprobantes).toBe(1)

    const adminB = await seedOperator(TENANT_B, { role: "superadmin", name: "Bee Admin", email: "admin.b@example.com" })
    login(adminB, { tenantId: TENANT_B })
    const resB = await pendingCountsRoute(req("", TENANT_B))
    expect((await resB.json()).comprobantes).toBe(2)
  })

  it("cache raw: dos consultas seguidas del mismo tenant pegan una sola vez a la ai-api", async () => {
    await pendingCountsRoute(req())
    await pendingCountsRoute(req())

    expect(listConversations).toHaveBeenCalledTimes(1)
    // El clear entre tests lo garantiza el beforeEach; acá el TTL aún no venció.
    clearPendingCountsCache()
    await pendingCountsRoute(req())
    expect(listConversations).toHaveBeenCalledTimes(2)
  })
})
