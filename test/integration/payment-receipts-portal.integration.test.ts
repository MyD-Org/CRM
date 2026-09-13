import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { getDb } from "@/db"
import { paymentReceipts, tenants } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { receiptKeys } from "@/lib/r2"
import { MAX_FILE_BYTES } from "@/lib/receipt-validation"
import { seedTenant, truncateAll } from "./helpers"
import { FakeR2, seedReceipt } from "./fake-r2"
import { sendEmail } from "@/lib/email"

// Tests de integración del portal: init → PUT directo a R2 (simulado en el fake) → confirm.
// La DB es real (crm_test); se mockean los seams como en inbox-routes: iron-session (sesión
// del portal), next/headers, @/lib/email (spy del proveedor) y @/lib/r2 (fake en memoria).
//
// Mapeo a los TH de la spec (suite obligatoria):
//   TH #10 aislamiento del portal · TH #11 confirm idempotente · TH #12 fallo/skip de mail
//   TH #14 huérfanos uploading · TH #15 rate limit diario/por hora
//
// Nada de datos reales: tenants tenant-a/tenant-b, mails @example.com, clientes inventados.
// Cada test usa su propio codigocliente: el rate limit por hora es un Map en memoria del
// módulo de la ruta y NO se reinicia entre tests.

let session: Record<string, unknown>

// Estado del mock de @/lib/r2: hoisted porque el factory de vi.mock corre antes que los
// imports; `null` simula storage no configurado (las rutas responden 503).
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
  // /api/portal/pagos lee x-tenant-id vía headers() en getTenantConfig: el mock devuelve
  // tenant-a (los guards de seguridad usan el host del Request, no este header).
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

const { POST: initRoute, GET: listRoute } = await import("@/app/api/portal/comprobantes/route")
const { POST: confirmRoute } = await import("@/app/api/portal/comprobantes/[id]/confirm/route")
const { GET: pagosRoute } = await import("@/app/api/portal/pagos/route")

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"
const RECEIPTS_EMAIL = "pagos@example.com"

// Magic bytes reales: el tipo se decide por sniffing, no por extensión ni content-type.
const PDF_BYTES = Uint8Array.from(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(256, 0x20)]))
const PNG_BYTES = Uint8Array.from(
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 0x21)]),
)
const SVG_BYTES = Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))

function login(codigocliente: string) {
  session = {
    isLoggedIn: true,
    codigocliente,
    razonsocial: "Cliente de Ejemplo S.A.",
    cuit: "30-71234567-8",
    email: "cliente@example.com",
    tipoCuenta: "corriente",
    save: async () => {},
  }
}
function logout() {
  session = {}
}

// NextRequest no materializa el Host desde la URL: hay que pasarlo explícito (en producción
// lo pone el proxy/HTTP de verdad; los guards resuelven el tenant del host).
const portalReq = (path: string, body?: unknown) =>
  body === undefined
    ? new NextRequest(`http://${TENANT_A}.localhost${path}`, { headers: { host: `${TENANT_A}.localhost` } })
    : new NextRequest(`http://${TENANT_A}.localhost${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { host: `${TENANT_A}.localhost` },
      })

const confirmParams = (id: string) => ({ params: Promise.resolve({ id }) })

const initBody = (overrides: Record<string, unknown> = {}) => ({
  amount: "1500.50",
  paidOn: "2026-09-10",
  method: "transferencia",
  file: { name: "comprobante.pdf", size: PDF_BYTES.length, contentType: "application/pdf" },
  ...overrides,
})

async function rowById(id: string) {
  const [row] = await getDb().select().from(paymentReceipts).where(eq(paymentReceipts.id, id))
  if (!row) throw new Error(`la fila ${id} no existe`)
  return row
}

/** init 201 + "PUT del navegador" (escritura directa en el fake). Devuelve el id. */
async function iniciarSubida(codigocliente: string, body: unknown, bytes: Uint8Array, contentType = "application/pdf") {
  login(codigocliente)
  const initRes = await initRoute(portalReq("/api/portal/comprobantes", body))
  expect(initRes.status).toBe(201)
  const { id } = (await initRes.json()) as { id: string }
  await fake.put(receiptKeys.tmp(TENANT_A, id), bytes, { contentType })
  return id
}

let fake: FakeR2

describe("portal: comprobantes de pago (init / PUT / confirm)", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await truncateAll()
    await seedTenant(TENANT_A, { receiptsEmail: RECEIPTS_EMAIL })
    await seedTenant(TENANT_B, { receiptsEmail: "pagos-b@example.com" })
    invalidateTenantRegistry()
    fake = new FakeR2()
    r2Holder.client = fake
    process.env.RECEIPTS_EMAIL_FROM = "receipts@example.com"
    vi.mocked(sendEmail).mockResolvedValue(true)
    login("CLI-000")
  })

  afterAll(async () => {
    await truncateAll()
  })

  describe("sesión", () => {
    it("init y confirm sin sesión ⇒ 401", async () => {
      logout()
      expect((await initRoute(portalReq("/api/portal/comprobantes", initBody()))).status).toBe(401)
      const id = randomUUID()
      expect((await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))).status).toBe(401)
    })
  })

  describe("camino feliz", () => {
    it("init 201 → PUT → confirm 200 ⇒ fila pending, objeto final = bytes, tmp borrado, 1 mail sent", async () => {
      login("CLI-HAPPY")
      const initRes = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      expect(initRes.status).toBe(201)
      expect(initRes.headers.get("cache-control")).toBe("private, no-store")
      const initJson = (await initRes.json()) as {
        id: string
        upload: { url: string; method: string; headers: Record<string, string> }
      }
      expect(initJson.upload.method).toBe("PUT")
      expect(initJson.upload.headers["content-type"]).toBe("application/pdf")
      expect(initJson.upload.url).toContain(`/tmp/receipts/${TENANT_A}/${initJson.id}`)

      // El navegador haría el PUT a la URL prefirmada: acá se escribe directo en el fake.
      await fake.put(receiptKeys.tmp(TENANT_A, initJson.id), PDF_BYTES, { contentType: "application/pdf" })

      const confirmRes = await confirmRoute(
        portalReq(`/api/portal/comprobantes/${initJson.id}/confirm`),
        confirmParams(initJson.id),
      )
      expect(confirmRes.status).toBe(200)
      expect(await confirmRes.json()).toEqual({ id: initJson.id, status: "pending" })

      const row = await rowById(initJson.id)
      expect(row.status).toBe("pending")
      expect(row.codigocliente).toBe("CLI-HAPPY")
      expect(row.razonsocial).toBe("Cliente de Ejemplo S.A.")
      expect(row.amount).toBe("1500.50")
      expect(row.method).toBe("transferencia")
      expect(row.submittedAt).not.toBeNull()
      expect(row.fileKey).toMatch(new RegExp(`^receipts/${TENANT_A}/\\d{4}-\\d{2}/${initJson.id}\\.pdf$`))
      expect(row.fileMime).toBe("application/pdf")
      expect(row.fileSize).toBe(PDF_BYTES.length)
      expect(row.fileSha256).toBe(createHash("sha256").update(PDF_BYTES).digest("hex"))

      // El objeto final tiene EXACTAMENTE los bytes subidos y el tmp ya no existe.
      const finalObj = fake.objects.get(row.fileKey ?? "")
      expect(finalObj).toBeDefined()
      expect(finalObj?.body).toEqual(PDF_BYTES)
      expect(fake.objects.has(receiptKeys.tmp(TENANT_A, initJson.id))).toBe(false)

      // 1 solo mail: destino del tenant, from de plataforma con display name, idempotencyKey
      // del intento 1 y el adjunto (el PDF entra en 10 MB).
      expect(sendEmail).toHaveBeenCalledTimes(1)
      const [, to, subject, , , opts] = vi.mocked(sendEmail).mock.calls[0]
      expect(to).toBe(RECEIPTS_EMAIL)
      expect(subject).toMatch(/^\[Comprobante de pago\]/)
      expect(opts?.from).toBe(`"Tenant de Test · Comprobantes" <receipts@example.com>`)
      expect(opts?.idempotencyKey).toBe(`payment-receipt/${initJson.id}/1`)
      expect(opts?.attachments).toHaveLength(1)
      expect(row.emailStatus).toBe("sent")
      expect(row.emailAttempts).toBe(1)
      expect(row.emailSentAt).not.toBeNull()
    })

    it("confirm sin PUT previo ⇒ 409 y la fila sigue uploading, sin mail", async () => {
      login("CLI-NOPUT")
      const initRes = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      const { id } = (await initRes.json()) as { id: string }

      const confirmRes = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(confirmRes.status).toBe(409)
      expect((await confirmRes.json()).code).toBe("upload_missing")
      expect((await rowById(id)).status).toBe("uploading")
      expect(sendEmail).not.toHaveBeenCalled()
    })
  })

  describe("TH #11: confirm idempotente", () => {
    it("confirm dos veces ⇒ 200 idempotente, 1 solo mail y submitted_at estable", async () => {
      const id = await iniciarSubida("CLI-IDEM", initBody(), PDF_BYTES)
      const primero = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(primero.status).toBe(200)
      const submittedAtPrimero = (await rowById(id)).submittedAt

      const segundo = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(segundo.status).toBe(200)
      expect(await segundo.json()).toEqual({ id, status: "pending" })

      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect((await rowById(id)).submittedAt).toEqual(submittedAtPrimero)
    })

    it("dos confirms concurrentes ⇒ exactamente 1 mail y la fila termina pending una sola vez", async () => {
      const id = await iniciarSubida("CLI-CONC", initBody(), PDF_BYTES)

      const [r1, r2] = await Promise.all([
        confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id)),
        confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id)),
      ])
      // Uno publica (200); el otro ve la fila en processing/pending y responde 202 o 200.
      for (const res of [r1, r2]) expect([200, 202]).toContain(res.status)

      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect((await rowById(id)).status).toBe("pending")
      expect(fake.objects.has(receiptKeys.tmp(TENANT_A, id))).toBe(false)
    })

    it("un processing con lease vencido se retoma y completa", async () => {
      const row = await seedReceipt(TENANT_A, "CLI-LEASE", {
        status: "processing",
        processingStartedAt: new Date(Date.now() - 121 * 1000),
        declaredSize: PDF_BYTES.length,
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      await fake.put(receiptKeys.tmp(TENANT_A, row.id), PDF_BYTES, { contentType: "application/pdf" })

      login("CLI-LEASE")
      const res = await confirmRoute(portalReq(`/api/portal/comprobantes/${row.id}/confirm`), confirmParams(row.id))
      expect(res.status).toBe(200)
      expect((await res.json()).status).toBe("pending")
      expect(sendEmail).toHaveBeenCalledTimes(1)
    })
  })

  describe("validación del archivo (magic bytes, tamaño)", () => {
    it("SVG disfrazado de png ⇒ 415, sin objeto final, la fila queda rejected y sin mail", async () => {
      const body = initBody({ file: { name: "foto.png", size: SVG_BYTES.length, contentType: "image/png" } })
      const id = await iniciarSubida("CLI-SVG", body, SVG_BYTES, "image/png")

      const confirmRes = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(confirmRes.status).toBe(415)
      expect((await confirmRes.json()).code).toBe("unsupported_type")
      const row = await rowById(id)
      expect(row.status).toBe("rejected")
      expect(row.rejectReason).toBe("unsupported_type")
      expect(fake.keysWithPrefix("receipts/")).toHaveLength(0)
      expect(fake.objects.has(receiptKeys.tmp(TENANT_A, id))).toBe(false)
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it("tmp mutado entre el range y el GET ⇒ el re-sniff rechaza (415), sin objeto final", async () => {
      const body = initBody({ file: { name: "foto.png", size: PNG_BYTES.length, contentType: "image/png" } })
      const id = await iniciarSubida("CLI-TOCTOU", body, PNG_BYTES, "image/png")

      // Entre el sniff del range (png) y el GET completo, el tmp se reemplaza por un PDF
      // del MISMO tamaño: el re-sniff detecta el cambio y rechaza.
      const mutado = Uint8Array.from(
        Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(PNG_BYTES.length - 9, 0x20)]),
      )
      const tmpKey = receiptKeys.tmp(TENANT_A, id)
      fake.onAfterGetRange = (key: string) => {
        if (key === tmpKey) fake.put(key, mutado, { contentType: "image/png" })
      }

      const confirmRes = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(confirmRes.status).toBe(415)
      expect((await confirmRes.json()).code).toBe("unsupported_type")
      expect((await rowById(id)).status).toBe("rejected")
      expect(fake.keysWithPrefix("receipts/")).toHaveLength(0)
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it("init declarando 20 MiB + 1 byte ⇒ 413 y sin fila", async () => {
      login("CLI-BIGINIT")
      const body = initBody({ file: { name: "grande.pdf", size: MAX_FILE_BYTES + 1, contentType: "application/pdf" } })
      const res = await initRoute(portalReq("/api/portal/comprobantes", body))

      expect(res.status).toBe(413)
      expect((await res.json()).code).toBe("file_too_large")
      const rows = await getDb().select().from(paymentReceipts)
      expect(rows).toHaveLength(0)
    })

    it("confirm con tmp de 21 MiB ⇒ 413 file_too_large, rejected y sin objeto final", async () => {
      const big = 21 * 1024 * 1024
      // Declara un tamaño válido: el 413 file_too_large sale del HEAD real (21 MiB > 20 MiB),
      // no de un declared_size imposible (la migración lo rechazaría con CHECK).
      const row = await seedReceipt(TENANT_A, "CLI-BIGCONFIRM", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      await fake.put(receiptKeys.tmp(TENANT_A, row.id), new Uint8Array(big).fill(0x41), { contentType: "application/pdf" })

      login("CLI-BIGCONFIRM")
      const res = await confirmRoute(portalReq(`/api/portal/comprobantes/${row.id}/confirm`), confirmParams(row.id))
      expect(res.status).toBe(413)
      expect((await res.json()).code).toBe("file_too_large")
      const after = await rowById(row.id)
      expect(after.status).toBe("rejected")
      expect(after.rejectReason).toBe("file_too_large")
      expect(fake.keysWithPrefix("receipts/")).toHaveLength(0)
      expect(fake.objects.has(receiptKeys.tmp(TENANT_A, row.id))).toBe(false)
      expect(sendEmail).not.toHaveBeenCalled()
    })
  })

  describe("TH #12: mail de aviso", () => {
    it("el proveedor falla ⇒ 200 igual, pending con email failed y el objeto final existe", async () => {
      const id = await iniciarSubida("CLI-MAILFAIL", initBody(), PDF_BYTES)

      vi.mocked(sendEmail).mockRejectedValueOnce(new Error("resend caido"))
      const res = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(res.status).toBe(200)

      const row = await rowById(id)
      expect(row.status).toBe("pending")
      expect(row.emailStatus).toBe("failed")
      expect(row.emailError).toBe("resend caido")
      expect(row.submittedAt).not.toBeNull()
      // Un fallo de mail NO revierte la publicación: el objeto final sigue ahí.
      expect(fake.objects.get(row.fileKey ?? "")).toBeDefined()
    })

    it("tenant sin destino ⇒ skipped, sin llamar al proveedor", async () => {
      await getDb().update(tenants).set({ receiptsEmail: "" }).where(eq(tenants.id, TENANT_A))
      const id = await iniciarSubida("CLI-NODESTINO", initBody(), PDF_BYTES)

      const res = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(res.status).toBe(200)
      expect(sendEmail).not.toHaveBeenCalled()
      const row = await rowById(id)
      expect(row.status).toBe("pending")
      expect(row.emailStatus).toBe("skipped")
      expect(row.emailError).toBe("mail destino no configurado")
    })
  })

  describe("TH #14: huérfanos de subidas abandonadas", () => {
    it("el init limpia los uploading de más de 24 h sin tocar pending (aunque sea viejo)", async () => {
      const hace25Horas = new Date(Date.now() - 25 * 60 * 60 * 1000)
      const hace3Dias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      const uploadingViejo = await seedReceipt(TENANT_A, "CLI-VIEJO", {
        status: "uploading",
        createdAt: hace25Horas,
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      const pendienteViejo = await seedReceipt(TENANT_A, "CLI-VIEJO", {
        status: "pending",
        createdAt: hace3Dias,
        submittedAt: hace3Dias,
      })

      login("CLI-NUEVO")
      const res = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      expect(res.status).toBe(201)

      const [viejo] = await getDb().select().from(paymentReceipts).where(eq(paymentReceipts.id, uploadingViejo.id))
      expect(viejo).toBeUndefined()
      const [viejoPendiente] = await getDb().select().from(paymentReceipts).where(eq(paymentReceipts.id, pendienteViejo.id))
      expect(viejoPendiente?.status).toBe("pending")
      expect(viejoPendiente?.createdAt).toEqual(hace3Dias)
    })
  })

  describe("TH #15: rate limit de informes", () => {
    it("20 comprobantes no-uploading en 24 h ⇒ 429 diario; otro cliente tiene cuota separada", async () => {
      for (let i = 0; i < 20; i++) await seedReceipt(TENANT_A, "CLI-DAILY")

      login("CLI-DAILY")
      const res = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      expect(res.status).toBe(429)
      expect((await res.json()).code).toBe("daily_limit")

      // La cuota es por cliente: otro del mismo tenant sí puede informar.
      login("CLI-OTRO")
      const otro = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      expect(otro.status).toBe(201)
    })

    it("10 inits en la última hora ⇒ el 11º da 429 hourly_limit y sin fila", async () => {
      login("CLI-HOURLY")
      for (let i = 0; i < 10; i++) {
        const res = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
        expect(res.status).toBe(201)
      }

      const res = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      expect(res.status).toBe(429)
      expect((await res.json()).code).toBe("hourly_limit")

      const rows = await getDb().select().from(paymentReceipts).where(eq(paymentReceipts.codigocliente, "CLI-HOURLY"))
      expect(rows).toHaveLength(10)
    })
  })

  describe("TH #10: aislamiento del portal", () => {
    it("X confirma el comprobante de Y ⇒ 404 idéntico al de un uuid inexistente, sin efectos", async () => {
      const deY = await seedReceipt(TENANT_A, "CLI-Y", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      await fake.put(receiptKeys.tmp(TENANT_A, deY.id), PDF_BYTES, { contentType: "application/pdf" })

      login("CLI-X")
      const resAjeno = await confirmRoute(portalReq(`/api/portal/comprobantes/${deY.id}/confirm`), confirmParams(deY.id))
      const uuidRandom = randomUUID()
      const resRandom = await confirmRoute(
        portalReq(`/api/portal/comprobantes/${uuidRandom}/confirm`),
        confirmParams(uuidRandom),
      )
      expect(resAjeno.status).toBe(404)
      expect(resRandom.status).toBe(404)
      expect(await resAjeno.json()).toEqual(await resRandom.json())

      // Sin efectos: la fila de Y no cambió y no se mandó mail.
      expect((await rowById(deY.id)).status).toBe("uploading")
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it("mismo codigocliente en otro tenant ⇒ 404 idéntico, sin efectos", async () => {
      const deB = await seedReceipt(TENANT_B, "CLI-X", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      await fake.put(receiptKeys.tmp(TENANT_B, deB.id), PDF_BYTES, { contentType: "application/pdf" })

      login("CLI-X") // mismo codigocliente, pero la sesión vive en el host del tenant-a
      const resAjeno = await confirmRoute(portalReq(`/api/portal/comprobantes/${deB.id}/confirm`), confirmParams(deB.id))
      const uuidRandom = randomUUID()
      const resRandom = await confirmRoute(
        portalReq(`/api/portal/comprobantes/${uuidRandom}/confirm`),
        confirmParams(uuidRandom),
      )
      expect(resAjeno.status).toBe(404)
      expect(await resAjeno.json()).toEqual(await resRandom.json())

      expect((await rowById(deB.id)).status).toBe("uploading")
      expect(sendEmail).not.toHaveBeenCalled()
    })

    it("el codigocliente/razonsocial del body se ignoran: la fila sale de la sesión", async () => {
      login("CLI-SESION")
      const res = await initRoute(
        portalReq(
          "/api/portal/comprobantes",
          initBody({ codigocliente: "CLI-EVIL", razonsocial: "Razón Ajena S.A.", cuit: "20-99999999-9" }),
        ),
      )
      expect(res.status).toBe(201)
      const { id } = (await res.json()) as { id: string }

      const row = await rowById(id)
      expect(row.codigocliente).toBe("CLI-SESION")
      expect(row.razonsocial).toBe("Cliente de Ejemplo S.A.")
      expect(row.cuit).toBe("30-71234567-8")
    })
  })

  describe("degradación sin storage", () => {
    it("sin R2 configurado ⇒ init 503 storage_unavailable y el resto del portal sigue OK", async () => {
      r2Holder.client = null // simula "las 4 o ninguna" sin configurar
      login("CLI-NOR2")
      const res = await initRoute(portalReq("/api/portal/comprobantes", initBody()))
      expect(res.status).toBe(503)
      expect((await res.json()).code).toBe("storage_unavailable")
      expect(await getDb().select().from(paymentReceipts)).toHaveLength(0)

      // /api/portal/pagos no depende de R2: sigue sirviendo con el storage caído.
      await getDb().update(tenants).set({ alegraMock: true }).where(eq(tenants.id, TENANT_A))
      const pagosRes = await pagosRoute(portalReq("/api/portal/pagos"))
      expect(pagosRes.status).toBe(200)
    })
  })

  describe("B: historial del portal (TH #17)", () => {
    it("solo propios: sin otros clientes/tenants, sin internos, sin datos de admin/mail/storage", async () => {
      const pendiente = await seedReceipt(TENANT_A, "CLI-HIST", { status: "pending" })
      const cargado = await seedReceipt(TENANT_A, "CLI-HIST", { status: "loaded" })
      await seedReceipt(TENANT_A, "CLI-OTRO", { status: "pending" })
      await seedReceipt(TENANT_B, "CLI-HIST", { status: "pending" })
      await seedReceipt(TENANT_A, "CLI-HIST", {
        status: "uploading",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })
      await seedReceipt(TENANT_A, "CLI-HIST", {
        status: "rejected",
        rejectReason: "unsupported_type",
        submittedAt: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        fileSha256: null,
      })

      login("CLI-HIST")
      const res = await listRoute(portalReq("/api/portal/comprobantes"))
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("private, no-store")

      const body = await res.json()
      expect(body.total).toBe(2)
      expect(new Set(body.comprobantes.map((c: { id: string }) => c.id))).toEqual(new Set([pendiente.id, cargado.id]))

      // DTO mínimo: nada de loaded_by*, email_*, file_key, file_sha256 ni URLs.
      for (const c of body.comprobantes) {
        expect(Object.keys(c).sort()).toEqual(
          ["amount", "currency", "fileOriginalName", "id", "method", "methodOther", "paidOn", "status", "submittedAt"].sort(),
        )
      }
      // El nombre del admin que marcó "cargado" no viaja al portal.
      expect(JSON.stringify(body)).not.toContain("Ana")
    })

    it("paginación: 12 propios ⇒ 10 + 2, recientes primero; start inválido ⇒ 400", async () => {
      const base = Date.now()
      for (let i = 0; i < 12; i++) {
        await seedReceipt(TENANT_A, "CLI-PAGE", { submittedAt: new Date(base - i * 60_000) })
      }

      login("CLI-PAGE")
      const p1 = await (await listRoute(portalReq("/api/portal/comprobantes?start=0"))).json()
      expect(p1.total).toBe(12)
      expect(p1.comprobantes).toHaveLength(10)
      expect(p1.comprobantes[0].submittedAt >= p1.comprobantes[9].submittedAt).toBe(true)

      const p2 = await (await listRoute(portalReq("/api/portal/comprobantes?start=10"))).json()
      expect(p2.comprobantes).toHaveLength(2)

      const p3 = await (await listRoute(portalReq("/api/portal/comprobantes?start=20"))).json()
      expect(p3.comprobantes).toHaveLength(0)
      expect(p3.total).toBe(12)

      expect((await listRoute(portalReq("/api/portal/comprobantes?start=abc"))).status).toBe(400)
      expect((await listRoute(portalReq("/api/portal/comprobantes?start=-1"))).status).toBe(400)
    })

    it("sin sesión ⇒ 401", async () => {
      logout()
      expect((await listRoute(portalReq("/api/portal/comprobantes"))).status).toBe(401)
    })
  })

  describe("B: aviso de duplicado (TH #17)", () => {
    it("mismo archivo dos veces ⇒ el segundo confirm responde duplicateOf y el mail avisa", async () => {
      const primero = await iniciarSubida("CLI-DUP", initBody(), PDF_BYTES)
      const r1 = await confirmRoute(portalReq(`/api/portal/comprobantes/${primero}/confirm`), confirmParams(primero))
      expect(r1.status).toBe(200)
      expect((await r1.json()).duplicateOf).toBeUndefined()

      const segundo = await iniciarSubida("CLI-DUP", initBody(), PDF_BYTES)
      const r2 = await confirmRoute(portalReq(`/api/portal/comprobantes/${segundo}/confirm`), confirmParams(segundo))
      expect(r2.status).toBe(200)
      const body2 = await r2.json()
      expect(body2.duplicateOf.id).toBe(primero)
      expect(body2.duplicateOf.submittedAt).toBe((await rowById(primero)).submittedAt?.toISOString())

      // Ambos quedan publicados (no bloquea) y el mail del segundo lleva el aviso.
      expect((await rowById(primero)).status).toBe("pending")
      expect((await rowById(segundo)).status).toBe("pending")
      expect(sendEmail).toHaveBeenCalledTimes(2)
      const [, , , html, text] = vi.mocked(sendEmail).mock.calls[1]
      expect(`${html} ${text}`).toContain("Posible duplicado")
    })

    it("mismo sha de OTRO cliente o de OTRO tenant ⇒ sin duplicateOf y sin aviso en el mail", async () => {
      const sha = createHash("sha256").update(PDF_BYTES).digest("hex")
      await seedReceipt(TENANT_A, "CLI-OTRO-DUP", { fileSha256: sha })
      await seedReceipt(TENANT_B, "CLI-DUPX", { fileSha256: sha })

      const id = await iniciarSubida("CLI-DUPX", initBody(), PDF_BYTES)
      const res = await confirmRoute(portalReq(`/api/portal/comprobantes/${id}/confirm`), confirmParams(id))
      expect(res.status).toBe(200)
      expect((await res.json()).duplicateOf).toBeUndefined()

      const ultima = vi.mocked(sendEmail).mock.calls.at(-1)
      expect(`${ultima?.[3] ?? ""} ${ultima?.[4] ?? ""}`).not.toContain("Posible duplicado")
    })
  })
})
