import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { getDb } from "@/db"
import { paymentReceipts, tenants } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { seedOperator, seedTenant, truncateAll } from "./helpers"
import { FakeR2, seedReceipt } from "./fake-r2"
import { sendEmail } from "@/lib/email"

// Tests de integración del backoffice de comprobantes. La DB es real (crm_test); se mockean
// iron-session (sesión admin), next/headers, @/lib/email (spy del proveedor) y @/lib/r2 (fake
// en memoria). El guard es el nuevo (requireAdminPlus): rol y tenant autoritativos de la DB.
//
// Mapeo a los TH de la spec (suite obligatoria):
//   TH #8 operator/cookie vieja ⇒ 404 · TH #9 aislamiento entre tenants · TH #12 reenvío
//   TH #13 marcar/deshacer con auditoría · TH #16 file ⇒ 302 (nunca bytes)
//
// Nada de datos reales: tenants tenant-a/tenant-b, mails @example.com, valores inventados.

let session: Record<string, unknown>

// Estado del mock de @/lib/r2 (mismo patrón que el test del portal): hoisted porque el
// factory de vi.mock corre antes que los imports; `null` simula storage no configurado.
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
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }))
vi.mock("@/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/r2")>()
  return {
    ...actual,
    getR2: () => r2Holder.client,
    r2Config: () => (r2Holder.client ? FAKE_R2_CONFIG : null),
  }
})

const { GET: listRoute } = await import("@/app/api/admin/comprobantes/route")
const { GET: detailRoute, PATCH: patchRoute } = await import("@/app/api/admin/comprobantes/[id]/route")
const { GET: fileRoute } = await import("@/app/api/admin/comprobantes/[id]/file/route")
const { POST: resendRoute } = await import("@/app/api/admin/comprobantes/[id]/resend-email/route")
const { GET: settingsGetRoute, PUT: settingsPutRoute } = await import("@/app/api/admin/settings/receipts/route")

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"

const NOT_FOUND_BODY = { error: "No encontrado", code: "not_found" }

function loginAdmin(userId: string, opts: { cookieRole?: string; tenantId?: string } = {}) {
  // `role`/`tenantId` de la cookie son lo que la cookie DICE; el guard manda lo de la DB.
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

// NextRequest no materializa el Host desde la URL: hay que pasarlo explícito (en producción
// lo pone el proxy/HTTP de verdad; los guards resuelven el tenant del host).
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

/** Comprobante publicado con su objeto presente en el fake (el reenvío lo adjunta: pesa
 *  menos de 10 MB y se lee de R2). */
async function seedConArchivo(emailStatus: "pending" | "sent" | "failed" | "skipped"): Promise<ReceiptRow> {
  const receipt = await seedReceipt(TENANT_A, "CLI-A", {
    emailStatus,
    emailError: emailStatus === "failed" ? "resend caido" : null,
  })
  await fake.put(receipt.fileKey ?? "", new Uint8Array(256).fill(0x25), { contentType: "application/pdf" })
  return receipt
}

let fake: FakeR2
let adminA: string
let betoA: string
let operatorA: string
let adminB: string

describe("admin: comprobantes de pago", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await truncateAll()
    await seedTenant(TENANT_A, { receiptsEmail: "pagos@example.com" })
    await seedTenant(TENANT_B, { receiptsEmail: "pagos-b@example.com" })
    adminA = await seedOperator(TENANT_A, { role: "admin", name: "Ana Admin", email: "ana.admin@example.com" })
    betoA = await seedOperator(TENANT_A, { role: "superadmin", name: "Beto Super", email: "beto.admin@example.com" })
    operatorA = await seedOperator(TENANT_A, { role: "operator", name: "Ope Rador", email: "ope.admin@example.com" })
    adminB = await seedOperator(TENANT_B, { role: "superadmin", name: "Admin Bee", email: "admin.b@example.com" })
    invalidateTenantRegistry()
    fake = new FakeR2()
    r2Holder.client = fake
    process.env.RECEIPTS_EMAIL_FROM = "receipts@example.com"
    vi.mocked(sendEmail).mockResolvedValue(true)
    loginAdmin(adminA)
  })

  afterAll(async () => {
    await truncateAll()
  })

  describe("TH #8: guard (401 sin sesión, 404 para operator)", () => {
    let receiptA: ReceiptRow

    beforeEach(async () => {
      receiptA = await seedReceipt(TENANT_A, "CLI-A")
    })

    const CASES: [string, () => Promise<Response>][] = [
      ["GET /api/admin/comprobantes", () => listRoute(adminReq("/api/admin/comprobantes"))],
      [
        "GET /api/admin/comprobantes/[id]",
        () => detailRoute(adminReq(`/api/admin/comprobantes/${receiptA.id}`), idParams(receiptA.id)),
      ],
      [
        "PATCH /api/admin/comprobantes/[id]",
        () =>
          patchRoute(
            adminReq(`/api/admin/comprobantes/${receiptA.id}`, { method: "PATCH", body: { status: "loaded" } }),
            idParams(receiptA.id),
          ),
      ],
      [
        "GET /api/admin/comprobantes/[id]/file",
        () => fileRoute(adminReq(`/api/admin/comprobantes/${receiptA.id}/file`), idParams(receiptA.id)),
      ],
      [
        "POST /api/admin/comprobantes/[id]/resend-email",
        () => resendRoute(adminReq(`/api/admin/comprobantes/${receiptA.id}/resend-email`), idParams(receiptA.id)),
      ],
      ["GET /api/admin/settings/receipts", () => settingsGetRoute(adminReq("/api/admin/settings/receipts"))],
      [
        "PUT /api/admin/settings/receipts",
        () =>
          settingsPutRoute(
            adminReq("/api/admin/settings/receipts", { method: "PUT", body: { receiptsEmail: "nuevo@example.com" } }),
          ),
      ],
    ]

    it.each(CASES)("%s → 401 sin sesión", async (_nombre, call) => {
      logout()
      expect((await call()).status).toBe(401)
    })

    it.each(CASES)("%s → 404 para operator, con el cuerpo de un id inexistente", async (_nombre, call) => {
      loginAdmin(operatorA)
      const res = await call()
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND_BODY)
    })

    it.each(CASES)("%s → 404 si la cookie dice admin pero la DB dice operator", async (_nombre, call) => {
      loginAdmin(operatorA, { cookieRole: "admin" }) // cookie vieja, emitida antes del degrade
      expect((await call()).status).toBe(404)
    })

    it("operator sin efectos: la fila sigue pending, sin URL firmada, sin mail y settings intactos", async () => {
      loginAdmin(operatorA)
      await patchRoute(
        adminReq(`/api/admin/comprobantes/${receiptA.id}`, { method: "PATCH", body: { status: "loaded" } }),
        idParams(receiptA.id),
      )
      await fileRoute(adminReq(`/api/admin/comprobantes/${receiptA.id}/file`), idParams(receiptA.id))
      await resendRoute(adminReq(`/api/admin/comprobantes/${receiptA.id}/resend-email`), idParams(receiptA.id))
      await settingsPutRoute(
        adminReq("/api/admin/settings/receipts", { method: "PUT", body: { receiptsEmail: "hackeado@example.com" } }),
      )

      expect((await rowById(receiptA.id)).status).toBe("pending")
      expect(fake.presignedUrls).toHaveLength(0)
      expect(sendEmail).not.toHaveBeenCalled()
      const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, TENANT_A))
      expect(tenant?.receiptsEmail).toBe("pagos@example.com")
    })
  })

  describe("TH #9: aislamiento entre tenants", () => {
    it("admin de B sobre un id de A ⇒ 404 idéntico al de un uuid inexistente, sin efectos", async () => {
      const deA = await seedReceipt(TENANT_A, "CLI-A")
      loginAdmin(adminB, { tenantId: TENANT_B })

      const uuidRandom = randomUUID()
      const resDetalleAjeno = await detailRoute(
        adminReq(`/api/admin/comprobantes/${deA.id}`, { host: TENANT_B }),
        idParams(deA.id),
      )
      const resDetalleRandom = await detailRoute(
        adminReq(`/api/admin/comprobantes/${uuidRandom}`, { host: TENANT_B }),
        idParams(uuidRandom),
      )
      expect(resDetalleAjeno.status).toBe(404)
      expect(await resDetalleAjeno.json()).toEqual(await resDetalleRandom.json())

      for (const call of [
        () => patchRoute(adminReq(`/api/admin/comprobantes/${deA.id}`, { method: "PATCH", body: { status: "loaded" }, host: TENANT_B }), idParams(deA.id)),
        () => fileRoute(adminReq(`/api/admin/comprobantes/${deA.id}/file`, { host: TENANT_B }), idParams(deA.id)),
        () => resendRoute(adminReq(`/api/admin/comprobantes/${deA.id}/resend-email`, { host: TENANT_B }), idParams(deA.id)),
      ]) {
        expect((await call()).status).toBe(404)
      }

      // Sin efectos: A sigue pending, no se firmó nada ni se mandó mail.
      expect((await rowById(deA.id)).status).toBe("pending")
      expect(fake.presignedUrls).toHaveLength(0)
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it("la lista de B no mezcla comprobantes de A (con ningún filtro)", async () => {
      const a1 = await seedReceipt(TENANT_A, "CLI-A-1")
      await seedReceipt(TENANT_A, "CLI-A-2")
      const b1 = await seedReceipt(TENANT_B, "CLI-B-1")
      const b2 = await seedReceipt(TENANT_B, "CLI-B-2", { status: "loaded" })
      loginAdmin(adminB, { tenantId: TENANT_B })

      const pendientes = await (await listRoute(adminReq("/api/admin/comprobantes", { host: TENANT_B }))).json()
      expect(pendientes.total).toBe(1)
      expect(pendientes.items.map((i: { id: string }) => i.id)).toEqual([b1.id])

      const todos = await (await listRoute(adminReq("/api/admin/comprobantes?status=all", { host: TENANT_B }))).json()
      expect(todos.total).toBe(2)
      expect(new Set(todos.items.map((i: { id: string }) => i.id))).toEqual(new Set([b1.id, b2.id]))
      expect(todos.items.some((i: { id: string }) => [a1.id].includes(i.id))).toBe(false)
    })

    it("settings de B devuelve el destino de B, no el de A", async () => {
      loginAdmin(adminB, { tenantId: TENANT_B })
      const res = await settingsGetRoute(adminReq("/api/admin/settings/receipts", { host: TENANT_B }))
      expect(await res.json()).toEqual({ receiptsEmail: "pagos-b@example.com" })
    })
  })

  describe("estados internos invisibles", () => {
    it("uploading/processing/rejected no aparecen en la lista ni el count, ni en el detalle", async () => {
      const pend = await seedReceipt(TENANT_A, "CLI-A")
      const internos = [
        await seedReceipt(TENANT_A, "CLI-A", {
          status: "uploading",
          submittedAt: null,
          fileKey: null,
          fileMime: null,
          fileSize: null,
          fileSha256: null,
        }),
        await seedReceipt(TENANT_A, "CLI-A", {
          status: "processing",
          processingStartedAt: new Date(),
          submittedAt: null,
          fileKey: null,
          fileMime: null,
          fileSize: null,
          fileSha256: null,
        }),
        await seedReceipt(TENANT_A, "CLI-A", {
          status: "rejected",
          rejectReason: "file_too_large",
          submittedAt: null,
          fileKey: null,
          fileMime: null,
          fileSize: null,
          fileSha256: null,
        }),
      ]

      const lista = await (await listRoute(adminReq("/api/admin/comprobantes"))).json()
      expect(lista.total).toBe(1)
      expect(lista.items.map((i: { id: string }) => i.id)).toEqual([pend.id])
      expect(lista.receiptsEmailConfigured).toBe(true)
      expect(lista.storageConfigured).toBe(true)

      const todos = await (await listRoute(adminReq("/api/admin/comprobantes?status=all"))).json()
      expect(todos.total).toBe(1)

      for (const interno of internos) {
        const res = await detailRoute(adminReq(`/api/admin/comprobantes/${interno.id}`), idParams(interno.id))
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual(NOT_FOUND_BODY)
      }
    })
  })

  describe("TH #13: marcar cargado en Alegra / deshacer", () => {
    it("marcar cargado graba loaded_by/loaded_by_name de la DB y loguea la auditoría", async () => {
      const receipt = await seedReceipt(TENANT_A, "CLI-A")
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})

      const res = await patchRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}`, { method: "PATCH", body: { status: "loaded" } }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.status).toBe("loaded")
      expect(json.loaded.byName).toBe("Ana Admin")

      const row = await rowById(receipt.id)
      expect(row.status).toBe("loaded")
      expect(row.loadedBy).toBe(adminA)
      expect(row.loadedByName).toBe("Ana Admin")
      expect(row.loadedAt).not.toBeNull()

      const logs = infoSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("payment_receipt_status_changed"))
        .map((line) => JSON.parse(line))
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({ receiptId: receipt.id, to: "loaded", actor: { id: adminA } })
      infoSpy.mockRestore()
    })

    it("deshacer limpia loaded_at/loaded_by pero conserva loaded_by_name (auditoría)", async () => {
      const receipt = await seedReceipt(TENANT_A, "CLI-A")
      await patchRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}`, { method: "PATCH", body: { status: "loaded" } }),
        idParams(receipt.id),
      )

      loginAdmin(betoA)
      const res = await patchRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}`, { method: "PATCH", body: { status: "pending" } }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      const row = await rowById(receipt.id)
      expect(row.status).toBe("pending")
      expect(row.loadedAt).toBeNull()
      expect(row.loadedBy).toBeNull()
      expect(row.loadedByName).toBe("Ana Admin")
    })

    it("doble marcar no pisa loaded_by: el segundo PATCH es 200 idempotente", async () => {
      const receipt = await seedReceipt(TENANT_A, "CLI-A")
      await patchRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}`, { method: "PATCH", body: { status: "loaded" } }),
        idParams(receipt.id),
      )
      const antes = await rowById(receipt.id)

      loginAdmin(betoA)
      const res = await patchRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}`, { method: "PATCH", body: { status: "loaded" } }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(200)
      const row = await rowById(receipt.id)
      expect(row.loadedBy).toBe(adminA) // sigue siendo Ana, no Beto
      expect(row.loadedByName).toBe("Ana Admin")
      expect(row.loadedAt).toEqual(antes.loadedAt)
    })

    it("PATCH con otro status ⇒ 400 y la fila no cambia", async () => {
      const receipt = await seedReceipt(TENANT_A, "CLI-A")
      const res = await patchRoute(
        adminReq(`/api/admin/comprobantes/${receipt.id}`, { method: "PATCH", body: { status: "uploading" } }),
        idParams(receipt.id),
      )
      expect(res.status).toBe(400)
      expect((await rowById(receipt.id)).status).toBe("pending")
    })

    it("PATCH sobre una fila uploading ⇒ 404 (invisible), sin efectos", async () => {
      const uploading = await seedReceipt(TENANT_A, "CLI-A", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      const res = await patchRoute(
        adminReq(`/api/admin/comprobantes/${uploading.id}`, { method: "PATCH", body: { status: "loaded" } }),
        idParams(uploading.id),
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND_BODY)
      expect((await rowById(uploading.id)).status).toBe("uploading")
    })
  })

  describe("TH #16: ver archivo (302, nunca bytes)", () => {
    it("responde 302 con la Location firmada del fake y headers no-store/no-referrer", async () => {
      const receipt = await seedReceipt(TENANT_A, "CLI-A")
      const res = await fileRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/file`), idParams(receipt.id))

      expect(res.status).toBe(302)
      const location = res.headers.get("location")
      expect(location).toContain(`/${receipt.fileKey}?`)
      expect(fake.presignedUrls).toContain(location)
      expect(res.headers.get("cache-control")).toBe("private, no-store")
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      // NUNCA bytes del archivo en el body de la respuesta.
      const body = await res.text()
      expect(body).not.toContain("%PDF")
      expect(body.length).toBeLessThan(300)
    })

    it("id ajeno, invisible o inexistente ⇒ 404 idéntico, sin firmar nada", async () => {
      const deB = await seedReceipt(TENANT_B, "CLI-B")
      const uploading = await seedReceipt(TENANT_A, "CLI-A", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      const uuidRandom = randomUUID()

      for (const id of [deB.id, uploading.id, uuidRandom]) {
        const res = await fileRoute(adminReq(`/api/admin/comprobantes/${id}/file`), idParams(id))
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual(NOT_FOUND_BODY)
      }
      expect(fake.presignedUrls).toHaveLength(0)
    })
  })

  describe("TH #12: reenviar mail", () => {
    it("failed → reenvío exitoso ⇒ 200 sent y el status del comprobante no se toca", async () => {
      const receipt = await seedConArchivo("failed")
      const res = await resendRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/resend-email`), idParams(receipt.id))

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.email.status).toBe("sent")
      expect(sendEmail).toHaveBeenCalledTimes(1)

      const row = await rowById(receipt.id)
      expect(row.emailStatus).toBe("sent")
      expect(row.emailSentAt).not.toBeNull()
      expect(row.emailError).toBeNull()
      expect(row.status).toBe("pending")
    })

    it("el proveedor sigue caído ⇒ 502 failed y el status del comprobante no se altera", async () => {
      const receipt = await seedConArchivo("failed")
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error("resend caido"))

      const res = await resendRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/resend-email`), idParams(receipt.id))
      expect(res.status).toBe(502)
      expect((await res.json()).code).toBe("email_failed")

      const row = await rowById(receipt.id)
      expect(row.emailStatus).toBe("failed")
      expect(row.emailError).toBe("resend caido")
      expect(row.status).toBe("pending")
    })

    it("sin destino configurado ⇒ 409 y no llama al proveedor", async () => {
      await getDb().update(tenants).set({ receiptsEmail: "" }).where(eq(tenants.id, TENANT_A))
      const receipt = await seedConArchivo("skipped")

      const res = await resendRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/resend-email`), idParams(receipt.id))
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe("email_skipped")
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it("dos reenvíos concurrentes ⇒ exactamente 1 envío (lease de 60 s)", async () => {
      const receipt = await seedConArchivo("failed")
      const [r1, r2] = await Promise.all([
        resendRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/resend-email`), idParams(receipt.id)),
        resendRoute(adminReq(`/api/admin/comprobantes/${receipt.id}/resend-email`), idParams(receipt.id)),
      ])

      expect([r1.status, r2.status].sort()).toEqual([200, 409])
      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect((await rowById(receipt.id)).emailStatus).toBe("sent")
    })
  })

  describe("settings de comprobantes (TS)", () => {
    it("GET devuelve el destino del tenant del guard", async () => {
      const res = await settingsGetRoute(adminReq("/api/admin/settings/receipts"))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ receiptsEmail: "pagos@example.com" })
    })

    it("PUT valida el email y solo toca su tenant (ignora tenantId del body)", async () => {
      const res = await settingsPutRoute(
        adminReq("/api/admin/settings/receipts", {
          method: "PUT",
          body: { receiptsEmail: "nuevo@example.com", tenantId: TENANT_B },
        }),
      )
      expect(res.status).toBe(200)

      const [a] = await getDb().select().from(tenants).where(eq(tenants.id, TENANT_A))
      const [b] = await getDb().select().from(tenants).where(eq(tenants.id, TENANT_B))
      expect(a?.receiptsEmail).toBe("nuevo@example.com")
      expect(b?.receiptsEmail).toBe("pagos-b@example.com")
    })

    it("PUT con varios destinatarios ⇒ 400 y no modifica nada", async () => {
      const res = await settingsPutRoute(
        adminReq("/api/admin/settings/receipts", {
          method: "PUT",
          body: { receiptsEmail: "a@example.com, b@example.com" },
        }),
      )
      expect(res.status).toBe(400)
      const [a] = await getDb().select().from(tenants).where(eq(tenants.id, TENANT_A))
      expect(a?.receiptsEmail).toBe("pagos@example.com")
    })

    it("PUT con email vacío ⇒ 200 y apaga el destino", async () => {
      const res = await settingsPutRoute(
        adminReq("/api/admin/settings/receipts", { method: "PUT", body: { receiptsEmail: "" } }),
      )
      expect(res.status).toBe(200)
      const [a] = await getDb().select().from(tenants).where(eq(tenants.id, TENANT_A))
      expect(a?.receiptsEmail).toBe("")
    })
  })
})
