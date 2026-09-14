import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { paymentReceipts } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { markLoadedFromAlegra, toAdminDto } from "@/lib/payment-receipts"
import { seedOperator, seedTenant, truncateAll } from "./helpers"
import { FakeR2, seedReceipt } from "./fake-r2"

// Tests de integración de "Cargar en Alegra" (crea el pago REAL en Alegra desde el
// backoffice). La DB es real (crm_test); se mockean iron-session/next-headers (sesión
// admin), @/lib/r2 (fake en memoria) y el fetch global por URL para Alegra. Nada de datos
// reales: tenants tenant-a/tenant-b, contacto "416", facturas y mails inventados.

let session: Record<string, unknown>

const { r2Holder, FAKE_R2_CONFIG } = vi.hoisted(() => ({
  r2Holder: { client: null as unknown as import("@/lib/r2").R2Client | null },
  FAKE_R2_CONFIG: {
    accountId: "fake-account",
    accessKeyId: "fake-key",
    secretAccessKey: "fake-secret",
    bucket: "fake-bucket",
    region: "auto",
  },
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({}),
  headers: async () => new Headers({ "x-tenant-id": "tenant-a" }),
}))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))
vi.mock("@/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/r2")>()
  return {
    ...actual,
    getR2: () => r2Holder.client,
    r2Config: () => (r2Holder.client ? FAKE_R2_CONFIG : null),
  }
})

const { GET: loadContextRoute } = await import("@/app/api/admin/comprobantes/[id]/load-context/route")
const { POST: loadToAlegraRoute } = await import("@/app/api/admin/comprobantes/[id]/load-to-alegra/route")

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"
const NOT_FOUND_BODY = { error: "No encontrado", code: "not_found" }

// ── Fetch falso de Alegra (por URL; el resto de fetch queda prohibido) ──
interface AlegraCall {
  method: string
  path: string
  body: unknown
}
const alegraState = {
  bankAccounts: [{ id: "7", name: "Banco de Prueba", type: "bank", status: "active" }],
  openInvoices: [
    { id: 101, numberTemplate: { fullNumber: "FV-1-000101" }, date: "2026-08-01", balance: 800, status: "open" },
    { id: 102, numberTemplate: { fullNumber: "FV-1-000102" }, date: "2026-09-01", balance: 1200.5, status: "open" },
  ],
  nextPaymentId: 501,
  paymentNumber: "1061" as string | null,
  fetchedPaymentNumber: "1062" as string | null, // número que devuelve el GET de refuerzo
  createStatus: 201,
  attachmentStatus: 200,
  calls: [] as AlegraCall[],
}

function fakeAlegraFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
  const method = (init?.method ?? (input as Request | undefined)?.method ?? "GET").toUpperCase()
  if (!url.includes("api.alegra.com")) return Promise.reject(new Error(`fetch inesperado en test: ${method} ${url}`))
  const path = url.replace("https://api.alegra.com/api/v1", "")
  const start = Number(new URL(url).searchParams.get("start") ?? "0")

  if (method === "GET" && path.startsWith("/bank-accounts")) {
    return Promise.resolve(Response.json(start === 0 ? alegraState.bankAccounts : []))
  }
  if (method === "GET" && path.startsWith("/invoices")) {
    return Promise.resolve(Response.json(start === 0 ? alegraState.openInvoices : []))
  }
  if (method === "POST" && path === "/payments") {
    let body: unknown = null
    try {
      body = JSON.parse(String(init?.body ?? "null"))
    } catch {
      body = null
    }
    alegraState.calls.push({ method, path, body })
    if (alegraState.createStatus !== 201) {
      return Promise.resolve(new Response("Alegra caído", { status: alegraState.createStatus }))
    }
    return Promise.resolve(
      Response.json(
        {
          id: alegraState.nextPaymentId,
          number: alegraState.paymentNumber,
          date: "2026-09-10",
          amount: 1500,
          paymentMethod: "transfer",
        },
        { status: 201 },
      ),
    )
  }
  if (method === "GET" && /^\/payments\/[^/]+$/.test(path)) {
    const id = path.split("/")[2]
    alegraState.calls.push({ method, path, body: null })
    return Promise.resolve(
      Response.json({ id: Number(id), number: alegraState.fetchedPaymentNumber, date: "2026-09-10", amount: 1500 }),
    )
  }
  if (method === "POST" && /\/payments\/[^/]+\/attachment$/.test(path)) {
    alegraState.calls.push({ method, path, body: init?.body ?? null })
    if (alegraState.attachmentStatus !== 200) {
      return Promise.resolve(new Response("adjunto falló", { status: alegraState.attachmentStatus }))
    }
    return Promise.resolve(Response.json({ id: "1", url: "https://cdn.alegra.example.com/archivo", name: "comprobante.pdf" }))
  }
  return Promise.reject(new Error(`fetch de Alegra no mockeado: ${method} ${path}`))
}

function resetAlegraState() {
  alegraState.bankAccounts = [{ id: "7", name: "Banco de Prueba", type: "bank", status: "active" }]
  alegraState.openInvoices = [
    { id: 101, numberTemplate: { fullNumber: "FV-1-000101" }, date: "2026-08-01", balance: 800, status: "open" },
    { id: 102, numberTemplate: { fullNumber: "FV-1-000102" }, date: "2026-09-01", balance: 1200.5, status: "open" },
  ]
  alegraState.nextPaymentId = 501
  alegraState.paymentNumber = "1061"
  alegraState.fetchedPaymentNumber = "1062"
  alegraState.createStatus = 201
  alegraState.attachmentStatus = 200
  alegraState.calls = []
}

function loginAdmin(userId: string, opts: { cookieRole?: string; tenantId?: string } = {}) {
  session = {
    userId,
    role: opts.cookieRole ?? "admin",
    tenantId: opts.tenantId ?? TENANT_A,
    name: "Ana Admin",
    email: "ana.admin@example.com",
    save: async () => {},
  }
}
function logout() {
  session = {}
}

const adminReq = (path: string, init: { method?: string; body?: unknown; host?: string } = {}) => {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET")
  const host = init.host ?? TENANT_A
  return new NextRequest(`http://${host}.localhost${path}`, {
    method,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { host: `${host}.localhost` },
  })
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

type ReceiptRow = typeof paymentReceipts.$inferSelect

async function rowById(id: string): Promise<ReceiptRow> {
  const [row] = await getDb().select().from(paymentReceipts).where(eq(paymentReceipts.id, id))
  if (!row) throw new Error(`la fila ${id} no existe`)
  return row
}

/** Comprobante pending con su archivo presente en el fake R2 (PDF chico). */
async function seedConArchivo(overrides: Partial<typeof paymentReceipts.$inferInsert> = {}): Promise<ReceiptRow> {
  const receipt = await seedReceipt(TENANT_A, "416", overrides)
  await fake.put(receipt.fileKey ?? "", new Uint8Array(256).fill(0x25), { contentType: "application/pdf" })
  return receipt
}

const BODY_VALIDO = {
  method: "transfer",
  bankAccountId: "7",
  allocations: [
    { invoiceId: "101", amount: "800.00" },
    { invoiceId: "102", amount: "700.00" },
  ],
}

let fake: FakeR2
let adminA: string
let operatorA: string
let adminB: string

describe("admin: cargar comprobante en Alegra", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    resetAlegraState()
    vi.stubGlobal("fetch", fakeAlegraFetch)
    await truncateAll()
    await seedTenant(TENANT_A, { receiptsEmail: "pagos@example.com" })
    await seedTenant(TENANT_B, { receiptsEmail: "pagos-b@example.com" })
    adminA = await seedOperator(TENANT_A, { role: "admin", name: "Ana Admin", email: "ana.admin@example.com" })
    await seedOperator(TENANT_A, { role: "superadmin", name: "Beto Super", email: "beto.admin@example.com" })
    operatorA = await seedOperator(TENANT_A, { role: "operator", name: "Ope Rador", email: "ope.admin@example.com" })
    adminB = await seedOperator(TENANT_B, { role: "superadmin", name: "Admin Bee", email: "admin.b@example.com" })
    invalidateTenantRegistry()
    fake = new FakeR2()
    r2Holder.client = fake
    loginAdmin(adminA)
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await truncateAll()
  })

  describe("guard y aislamiento", () => {
    let receipt: ReceiptRow

    beforeEach(async () => {
      receipt = await seedReceipt(TENANT_A, "416")
    })

    const CASOS: [string, () => Promise<Response>][] = [
      [
        "GET load-context",
        () => loadContextRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/load-context`), idParams(receipt.id)),
      ],
      [
        "POST load-to-alegra",
        () =>
          loadToAlegraRoute(
            adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
            idParams(receipt.id),
          ),
      ],
    ]

    it.each(CASOS)("%s → 401 sin sesión", async (_nombre, call) => {
      logout()
      expect((await call()).status).toBe(401)
    })

    it.each(CASOS)("%s → 404 para operator, con el cuerpo de un id inexistente", async (_nombre, call) => {
      loginAdmin(operatorA)
      const res = await call()
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND_BODY)
    })

    it("admin de B sobre un id de A ⇒ 404 idéntico al de un uuid inexistente, sin llamar a Alegra", async () => {
      const uuidRandom = crypto.randomUUID()
      loginAdmin(adminB, { tenantId: TENANT_B })

      const ajeno = await loadContextRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-context`, { host: TENANT_B }),
        idParams(receipt.id),
      )
      const random = await loadContextRoute(
        adminReq(`/api/admin/comprobantes/${uuidRandom}/load-context`, { host: TENANT_B }),
        idParams(uuidRandom),
      )
      expect(ajeno.status).toBe(404)
      expect(await ajeno.json()).toEqual(await random.json())

      const postAjeno = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO, host: TENANT_B }),
        idParams(receipt.id),
      )
      expect(postAjeno.status).toBe(404)
      expect(alegraState.calls).toHaveLength(0)
    })

    it("operator sin efectos: la fila sigue pending y no se llamó a Alegra", async () => {
      loginAdmin(operatorA)
      await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect((await rowById(receipt.id)).status).toBe("pending")
      expect(alegraState.calls).toHaveLength(0)
    })
  })

  describe("GET load-context", () => {
    it("devuelve facturas abiertas (más vieja primero) y cuentas bancarias", async () => {
      const receipt = await seedReceipt(TENANT_A, "416")
      const res = await loadContextRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-context`),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.openInvoices).toEqual([
        { alegraId: "101", number: "FV-1-000101", date: "2026-08-01", balance: 800 },
        { alegraId: "102", number: "FV-1-000102", date: "2026-09-01", balance: 1200.5 },
      ])
      expect(json.bankAccounts).toEqual([{ alegraId: "7", name: "Banco de Prueba" }])
    })

    it("Alegra 500 al listar facturas ⇒ 502 y nada cambia", async () => {
      const receipt = await seedReceipt(TENANT_A, "416")
      vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as Request).url
        if (url.includes("/invoices")) return Promise.resolve(new Response("boom", { status: 500 }))
        return fakeAlegraFetch(input, init)
      })
      const res = await loadContextRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-context`),
        idParams(receipt.id),
      )
      expect(res.status).toBe(502)
      expect((await res.json()).code).toBe("alegra_error")
    })

    it("comprobante en estado invisible (uploading) ⇒ 404", async () => {
      const uploading = await seedReceipt(TENANT_A, "416", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      const res = await loadContextRoute(
        adminReq(`/api/admin/comprobantes/${uploading.id}/load-context`),
        idParams(uploading.id),
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND_BODY)
    })
  })

  describe("POST load-to-alegra: flujo feliz", () => {
    it("crea el pago en Alegra con el formato de API esperado, adjunta el comprobante y marca la fila", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
      const receipt = await seedConArchivo()

      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      const dto = await res.json()
      expect(dto.status).toBe("loaded")
      expect(dto.alegra).toEqual({ id: 501, number: "1061" })
      expect(dto.declared).toBeNull()

      // Wire format hacia Alegra (verificado contra la doc de POST /payments).
      const createCall = alegraState.calls.find((c) => c.method === "POST" && c.path === "/payments")
      expect(createCall?.body).toEqual({
        client: 416,
        date: "2026-09-10", // paidOn default de la fila
        paymentMethod: "transfer",
        bankAccount: { id: 7 },
        invoices: [
          { id: 101, amount: 800 },
          { id: 102, amount: 700 },
        ],
        observations: "Informado por el cliente desde el portal",
      })

      // Adjunto al pago creado (bytes leídos del fake R2).
      const attachCall = alegraState.calls.find((c) => c.path === "/payments/501/attachment")
      expect(attachCall).toBeDefined()

      const row = await rowById(receipt.id)
      expect(row.status).toBe("loaded")
      expect(row.alegraPaymentId).toBe(501)
      expect(row.alegraPaymentNumber).toBe("1061")
      expect(row.loadedByName).toBe("Ana Admin")
      expect(row.declaredAmount).toBeNull()
      expect(row.declaredPaidOn).toBeNull()

      const logs = infoSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("payment_receipt_loaded_to_alegra"))
      expect(logs).toHaveLength(1)
      expect(JSON.parse(logs[0])).toMatchObject({ receiptId: receipt.id, alegraPaymentId: 501 })
      infoSpy.mockRestore()
    })

    it("si el POST no trae número, lo pide con GET /payments/{id} antes de rendirse", async () => {
      alegraState.paymentNumber = null
      const receipt = await seedConArchivo()
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      expect((await res.json()).alegra).toEqual({ id: 501, number: "1062" })
      expect((await rowById(receipt.id)).alegraPaymentNumber).toBe("1062")
      expect(alegraState.calls.some((c) => c.method === "GET" && c.path === "/payments/501")).toBe(true)
    })

    it("comprobante loaded a mano antes (sin alegra id) también se puede cargar", async () => {
      const receipt = await seedConArchivo({ status: "loaded" })
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      expect((await res.json()).alegra).toEqual({ id: 501, number: "1061" })
    })

    it("adjunto que falla no revierte la carga: 200 igual y fila cargada", async () => {
      alegraState.attachmentStatus = 500
      const receipt = await seedConArchivo()
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      expect((await res.json()).alegra).toEqual({ id: 501, number: "1061" })
      expect((await rowById(receipt.id)).alegraPaymentId).toBe(501)
    })

    it("archivo que supera los 2 MB de Alegra se salta (adjunto best-effort) y carga igual", async () => {
      const receipt = await seedConArchivo({ fileSize: 3_000_000 })
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      expect(alegraState.calls.some((c) => c.path.endsWith("/attachment"))).toBe(false)
      expect((await rowById(receipt.id)).alegraPaymentId).toBe(501)
    })
  })

  describe("POST load-to-alegra: idempotencia y errores", () => {
    it("doble POST ⇒ el segundo es 409 y no crea otro pago en Alegra", async () => {
      const receipt = await seedConArchivo()
      const primer = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(primer.status).toBe(200)

      const segundo = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(segundo.status).toBe(409)
      expect((await segundo.json()).code).toBe("already_loaded")
      // Un solo createPayment en Alegra: la guarda es la fila con alegra_payment_id.
      expect(alegraState.calls.filter((c) => c.path === "/payments")).toHaveLength(1)
    })

    it("loaded con alegra_payment_id ⇒ 409 y no llama a Alegra", async () => {
      const receipt = await seedConArchivo({
        status: "loaded",
        alegraPaymentId: 777,
        alegraPaymentNumber: "990",
      })
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe("already_loaded")
      expect(alegraState.calls).toHaveLength(0)
    })

    it("Alegra rechaza el pago ⇒ 502 y la fila queda intacta (pending, sin alegra id)", async () => {
      alegraState.createStatus = 500
      const receipt = await seedConArchivo()
      const antes = await rowById(receipt.id)

      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, { body: BODY_VALIDO }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(502)
      expect((await res.json()).code).toBe("alegra_error")

      const row = await rowById(receipt.id)
      expect(row.status).toBe("pending")
      expect(row.alegraPaymentId).toBeNull()
      expect(row.updatedAt).toEqual(antes.updatedAt)
      // No se intentó adjuntar nada si el pago no se creó.
      expect(alegraState.calls.some((c) => c.path.endsWith("/attachment"))).toBe(false)
    })

    it("validaciones 400: método, cuenta, allocations, saldos y fecha", async () => {
      const receipt = await seedConArchivo()
      const url = `/api/admin/comprobantes/${receipt.id}/load-to-alegra`
      const post = (body: unknown) => loadToAlegraRoute(adminReq(url, { body }), idParams(receipt.id))

      const casos: [string, unknown, string][] = [
        ["método inválido", { ...BODY_VALIDO, method: "paypal" }, "medio"],
        ["transfer sin cuenta", { ...BODY_VALIDO, bankAccountId: undefined }, "cuenta"],
        ["allocations vacío", { ...BODY_VALIDO, allocations: [] }, "al menos una factura"],
        ["ids repetidos", { ...BODY_VALIDO, allocations: [{ invoiceId: "101", amount: "100.00" }, { invoiceId: "101", amount: "200.00" }] }, "repetidas"],
        ["monto 0", { ...BODY_VALIDO, allocations: [{ invoiceId: "101", amount: "0" }] }, "mayores a 0"],
        ["suma distinta al monto", { ...BODY_VALIDO, allocations: [{ invoiceId: "101", amount: "800.00" }] }, "no coincide"],
        ["allocation > saldo", { ...BODY_VALIDO, allocations: [{ invoiceId: "101", amount: "900.00" }, { invoiceId: "102", amount: "600.00" }] }, "saldo"],
        ["factura que no está abierta", { ...BODY_VALIDO, allocations: [{ invoiceId: "999", amount: "1500.00" }] }, "no está entre las facturas abiertas"],
        ["paidOn futura", { ...BODY_VALIDO, paidOn: "2099-01-01" }, "no futura"],
        ["amount inválido", { ...BODY_VALIDO, amount: "mucho" }, "monto"],
      ]
      for (const [, body, mensaje] of casos) {
        const res = await post(body)
        expect(res.status).toBe(400)
        expect(String((await res.json()).error)).toContain(mensaje)
      }
      // Nada llegó a Alegra y la fila sigue pending.
      expect(alegraState.calls.filter((c) => c.path === "/payments")).toHaveLength(0)
      expect((await rowById(receipt.id)).status).toBe("pending")
    })

    it("cruce contra saldos: suma exacta con amount corregido ⇒ ok y persiste declared_*", async () => {
      const receipt = await seedConArchivo()
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, {
          body: {
            method: "cash",
            amount: "1400.00",
            paidOn: "2026-09-05",
            allocations: [
              { invoiceId: "101", amount: "800.00" },
              { invoiceId: "102", amount: "600.00" },
            ],
          },
        }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      const dto = await res.json()
      expect(dto.amount).toBe("1400.00")
      expect(dto.paidOn).toBe("2026-09-05")
      expect(dto.declared).toEqual({ amount: "1500.00", paidOn: "2026-09-10" })
      expect(dto.alegra).toEqual({ id: 501, number: "1061" })

      const row = await rowById(receipt.id)
      expect(row.amount).toBe("1400.00")
      expect(row.paidOn).toBe("2026-09-05")
      expect(row.declaredAmount).toBe("1500.00")
      expect(row.declaredPaidOn).toBe("2026-09-10")

      const createCall = alegraState.calls.find((c) => c.method === "POST" && c.path === "/payments")
      expect(createCall?.body).toMatchObject({ date: "2026-09-05", paymentMethod: "cash" })
      expect((createCall?.body as Record<string, unknown>)["bankAccount"]).toBeUndefined()
    })

    it("amount igual al declarado (normalizado) ⇒ declared queda null", async () => {
      const receipt = await seedConArchivo()
      const res = await loadToAlegraRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}/load-to-alegra`, {
          body: { ...BODY_VALIDO, amount: "1500.00", paidOn: "2026-09-10" },
        }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      expect((await res.json()).declared).toBeNull()
      expect((await rowById(receipt.id)).declaredAmount).toBeNull()
    })
  })

  describe("markLoadedFromAlegra (repo)", () => {
    it("aplica una vez; la segunda vez (con alegra id) ⇒ null y no pisa nada", async () => {
      const receipt = await seedReceipt(TENANT_A, "416")
      const now = new Date()

      const primera = await markLoadedFromAlegra(
        TENANT_A,
        receipt.id,
        {
          alegraPaymentId: 501,
          alegraPaymentNumber: "1061",
          amount: "1500.00",
          paidOn: "2026-09-10",
          declaredAmount: null,
          declaredPaidOn: null,
          adminUserId: adminA,
        },
        now,
      )
      expect(primera?.status).toBe("loaded")
      expect(primera?.alegraPaymentId).toBe(501)
      expect(primera?.loadedByName).toBe("Ana Admin")

      const segunda = await markLoadedFromAlegra(
        TENANT_A,
        receipt.id,
        {
          alegraPaymentId: 502,
          alegraPaymentNumber: "1062",
          amount: "1500.00",
          paidOn: "2026-09-10",
          declaredAmount: null,
          declaredPaidOn: null,
          adminUserId: adminA,
        },
        new Date(),
      )
      expect(segunda).toBeNull()
      const row = await rowById(receipt.id)
      expect(row.alegraPaymentId).toBe(501)
      expect(row.alegraPaymentNumber).toBe("1061")
    })

    it("guarda declared_* tal cual vienen (auditoría de la corrección) y solo toca su tenant", async () => {
      const receipt = await seedReceipt(TENANT_A, "416")
      const ahora = new Date()
      await markLoadedFromAlegra(
        TENANT_A,
        receipt.id,
        {
          alegraPaymentId: 501,
          alegraPaymentNumber: null,
          amount: "1400.00",
          paidOn: "2026-09-05",
          declaredAmount: "1500.00",
          declaredPaidOn: "2026-09-10",
          adminUserId: adminA,
        },
        ahora,
      )
      const row = await rowById(receipt.id)
      expect(row.declaredAmount).toBe("1500.00")
      expect(row.declaredPaidOn).toBe("2026-09-10")
      expect(row.amount).toBe("1400.00")
      expect(row.paidOn).toBe("2026-09-05")
      expect(row.alegraPaymentNumber).toBeNull()
      // El DTO serializa declared para el diálogo.
      expect(toAdminDto(row, ahora).declared).toEqual({ amount: "1500.00", paidOn: "2026-09-10" })

      // Id ajeno: null, sin efectos.
      const ajeno = await markLoadedFromAlegra(
        TENANT_B,
        receipt.id,
        {
          alegraPaymentId: 999,
          alegraPaymentNumber: null,
          amount: "1500.00",
          paidOn: "2026-09-10",
          declaredAmount: null,
          declaredPaidOn: null,
          adminUserId: adminA,
        },
        new Date(),
      )
      expect(ajeno).toBeNull()
      expect((await rowById(receipt.id)).alegraPaymentId).toBe(501)
    })
  })
})
