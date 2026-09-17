import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { getDb } from "@/db"
import { installmentOptions, paymentMethods } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { seedOperator, seedTenant, truncateAll } from "./helpers"
import { validarJsonSchema } from "../contracts/json-schema-lite"
import schema from "../contracts/cuotas/v1/schema.json"

// Integración de Medios de pago / Cuotas (L4 de cuotas-configurables). DB real (crm_test); se
// mockean iron-session y next/headers como en los tests de comprobantes. El ping al Shop usa el
// fetch global (stub) para probar que un Shop caído NO revierte el guardado.
//
// Nota: requireAdminPlus responde 404 (no 403) a un operator — política del guard del proyecto
// para no filtrar existencia. La spec decía 403; se respeta el guard existente.

let session: Record<string, unknown>

vi.mock("next/headers", () => ({
  cookies: async () => ({}),
  headers: async () => new Headers({ "x-tenant-id": "tenant-a" }),
}))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))

const medios = await import("@/app/api/admin/cuotas/medios/route")
const medioId = await import("@/app/api/admin/cuotas/medios/[id]/route")
const opciones = await import("@/app/api/admin/cuotas/opciones/route")
const opcionId = await import("@/app/api/admin/cuotas/opciones/[id]/route")
const interno = await import("@/app/api/internal/shop/cuotas/route")

const TENANT_A = "tenant-a"
const TENANT_B = "tenant-b"
const NOT_FOUND_BODY = { error: "No encontrado", code: "not_found" }
const SECRET = "internal-test-secret"

function login(userId: string, tenantId = TENANT_A) {
  session = { userId, role: "admin", tenantId, name: "Ana", email: "ana@example.com", save: async () => {} }
}

const req = (path: string, init: { method?: string; body?: unknown; host?: string } = {}) => {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET")
  const host = init.host ?? TENANT_A
  return new NextRequest(`http://${host}.localhost${path}`, {
    method,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { host: `${host}.localhost` },
  })
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

const internoReq = (query: string, auth: string | null = `Bearer ${SECRET}`) =>
  new NextRequest(`http://${TENANT_A}.localhost/api/internal/shop/cuotas${query}`, {
    headers: { host: `${TENANT_A}.localhost`, ...(auth ? { authorization: auth } : {}) },
  })

async function crearMedio(body: Record<string, unknown>, host = TENANT_A) {
  const res = await medios.POST(req("/api/admin/cuotas/medios", { body, host }))
  return { res, json: await res.json() }
}

async function crearOpcion(body: Record<string, unknown>, host = TENANT_A) {
  const res = await opciones.POST(req("/api/admin/cuotas/opciones", { body, host }))
  return { res, json: await res.json() }
}

const fetchMock = vi.fn()

let adminA: string
let operatorA: string
let adminB: string

describe("cuotas: rutas admin e interna", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await truncateAll()
    await seedTenant(TENANT_A)
    await seedTenant(TENANT_B)
    adminA = await seedOperator(TENANT_A, { role: "admin" })
    operatorA = await seedOperator(TENANT_A, { role: "operator" })
    adminB = await seedOperator(TENANT_B, { role: "superadmin" })
    invalidateTenantRegistry()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("SHOP_INTERNAL_URL", "")
    vi.stubEnv("INTERNAL_SECRET", SECRET)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login(adminA)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await truncateAll()
  })

  describe("guard", () => {
    it("sin sesión → 401", async () => {
      session = {}
      expect((await medios.GET(req("/api/admin/cuotas/medios"))).status).toBe(401)
      expect((await opciones.POST(req("/api/admin/cuotas/opciones", { body: {} }))).status).toBe(401)
    })

    it("operator → 404 en lecturas y escrituras, sin persistir", async () => {
      login(operatorA)
      const res = await medios.POST(req("/api/admin/cuotas/medios", { body: { proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa" } }))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND_BODY)
      expect((await opciones.GET(req("/api/admin/cuotas/opciones"))).status).toBe(404)
      expect(await getDb().select().from(paymentMethods)).toHaveLength(0)
    })
  })

  describe("medios", () => {
    it("alta, listado y duplicado proveedor+código → 422", async () => {
      const { res, json } = await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", tenantId: TENANT_B })
      expect(res.status).toBe(201)
      expect(json).toMatchObject({ ok: true, propagado: false, medio: { codigoProveedor: "visa", activo: true, orden: 0 } })

      const [row] = await getDb().select().from(paymentMethods)
      expect(row?.tenantId).toBe(TENANT_A) // el tenantId del body se ignora

      const dup = await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Otra Visa" })
      expect(dup.res.status).toBe(422)
      expect(dup.json.code).toBe("duplicado")

      // El mismo medio en OTRO tenant sí se puede.
      login(adminB, TENANT_B)
      expect((await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa" }, TENANT_B)).res.status).toBe(201)

      login(adminA)
      const list = await (await medios.GET(req("/api/admin/cuotas/medios"))).json()
      expect(list.medios).toHaveLength(1)
    })

    it("validación → 422 con campo", async () => {
      const { res, json } = await crearMedio({ proveedor: "mercadopago", codigoProveedor: "", nombre: "Visa" })
      expect(res.status).toBe(422)
      expect(json).toMatchObject({ code: "invalid", campo: "codigoProveedor" })
    })

    it("PATCH desactiva; de otro tenant o id basura → 404", async () => {
      const { json } = await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa" })
      const id = json.medio.id as string

      const ok = await medioId.PATCH(req(`/api/admin/cuotas/medios/${id}`, { method: "PATCH", body: { activo: false } }), idParams(id))
      expect(ok.status).toBe(200)
      expect((await ok.json()).medio).toMatchObject({ activo: false, nombre: "Visa" })

      login(adminB, TENANT_B)
      const ajeno = await medioId.PATCH(req(`/api/admin/cuotas/medios/${id}`, { method: "PATCH", body: { activo: true }, host: TENANT_B }), idParams(id))
      expect(ajeno.status).toBe(404)
      expect(await ajeno.json()).toEqual(NOT_FOUND_BODY)
      const basura = await medioId.PATCH(req(`/api/admin/cuotas/medios/x`, { method: "PATCH", body: {}, host: TENANT_B }), idParams("x"))
      expect(basura.status).toBe(404)

      const [row] = await getDb().select().from(paymentMethods).where(eq(paymentMethods.id, id))
      expect(row?.activo).toBe(false)
    })
  })

  describe("opciones", () => {
    let visa: string

    beforeEach(async () => {
      visa = (await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa" })).json.medio.id
    })

    it("crear visa 6 sin interés desde 150.000", async () => {
      const { res, json } = await crearOpcion({ paymentMethodId: visa, cuotas: 6, sinInteres: true, montoMinimo: "150000" })
      expect(res.status).toBe(201)
      expect(json).toMatchObject({
        ok: true,
        propagado: false,
        opcion: { paymentMethodId: visa, cuotas: 6, sinInteres: true, montoMinimo: "150000.00", vigenteDesde: null, activo: true },
      })
      const [row] = await getDb().select().from(installmentOptions)
      expect(row?.updatedBy).toBe(adminA)
      expect(row?.tenantId).toBe(TENANT_A)
    })

    it.each([
      [{ cuotas: 1 }, "cuotas"],
      [{ cuotas: 30 }, "cuotas"],
      [{ cuotas: 6, montoMinimo: -5 }, "montoMinimo"],
      [{ cuotas: 6, vigenteDesde: "2026-10-31", vigenteHasta: "2026-10-01" }, "vigenteHasta"],
    ])("inválida %j → 422 y no persiste", async (extra, campo) => {
      const { res, json } = await crearOpcion({ paymentMethodId: visa, ...extra })
      expect(res.status).toBe(422)
      expect(json).toMatchObject({ code: "invalid", campo })
      expect(await getDb().select().from(installmentOptions)).toHaveLength(0)
    })

    it("superposición: sin vigencia + octubre → 422; con la primera hasta 30/09 → acepta", async () => {
      const primera = (await crearOpcion({ paymentMethodId: visa, cuotas: 6 })).json.opcion.id as string
      const octubre = { paymentMethodId: visa, cuotas: 6, vigenteDesde: "2026-10-01", vigenteHasta: "2026-10-31" }

      const choque = await crearOpcion(octubre)
      expect(choque.res.status).toBe(422)
      expect(choque.json).toMatchObject({ code: "superpuesta", conId: primera })

      const patch = await opcionId.PATCH(
        req(`/api/admin/cuotas/opciones/${primera}`, { method: "PATCH", body: { vigenteHasta: "2026-09-30" } }),
        idParams(primera),
      )
      expect(patch.status).toBe(200)
      expect((await crearOpcion(octubre)).res.status).toBe(201)
    })

    it("dos altas concurrentes iguales → sólo una persiste (advisory lock)", async () => {
      const [a, b] = await Promise.all([
        crearOpcion({ paymentMethodId: visa, cuotas: 12 }),
        crearOpcion({ paymentMethodId: visa, cuotas: 12 }),
      ])
      expect([a.res.status, b.res.status].sort()).toEqual([201, 422])
      expect(await getDb().select().from(installmentOptions)).toHaveLength(1)
    })

    it("aislamiento: tenant B no lista, no edita, no borra y no usa medios de A", async () => {
      const id = (await crearOpcion({ paymentMethodId: visa, cuotas: 3 })).json.opcion.id as string

      login(adminB, TENANT_B)
      const list = await (await opciones.GET(req("/api/admin/cuotas/opciones", { host: TENANT_B }))).json()
      expect(list.opciones).toEqual([])

      const patch = await opcionId.PATCH(req(`/api/admin/cuotas/opciones/${id}`, { method: "PATCH", body: { cuotas: 4 }, host: TENANT_B }), idParams(id))
      expect(patch.status).toBe(404)
      expect(await patch.json()).toEqual(NOT_FOUND_BODY)

      const del = await opcionId.DELETE(req(`/api/admin/cuotas/opciones/${id}`, { method: "DELETE", host: TENANT_B }), idParams(id))
      expect(del.status).toBe(404)

      const conMedioAjeno = await crearOpcion({ paymentMethodId: visa, cuotas: 6 }, TENANT_B)
      expect(conMedioAjeno.res.status).toBe(404)

      const [row] = await getDb().select().from(installmentOptions).where(eq(installmentOptions.id, id))
      expect(row?.cuotas).toBe(3)
    })

    it("DELETE borra", async () => {
      const id = (await crearOpcion({ paymentMethodId: visa, cuotas: 3 })).json.opcion.id as string
      const res = await opcionId.DELETE(req(`/api/admin/cuotas/opciones/${id}`, { method: "DELETE" }), idParams(id))
      expect(res.status).toBe(200)
      expect(await getDb().select().from(installmentOptions)).toHaveLength(0)
    })

    it("ping al Shop: caído → persiste igual con propagado:false; OK → propagado:true", async () => {
      vi.stubEnv("SHOP_INTERNAL_URL", "https://shop.test")
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
      const caido = await crearOpcion({ paymentMethodId: visa, cuotas: 3 })
      expect(caido.res.status).toBe(201)
      expect(caido.json.propagado).toBe(false)
      expect(await getDb().select().from(installmentOptions)).toHaveLength(1)

      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }))
      const ok = await crearOpcion({ paymentMethodId: visa, cuotas: 6 })
      expect(ok.json.propagado).toBe(true)
      const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
      expect(url).toBe("https://shop.test/api/internal/cuotas/revalidar")
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${SECRET}`)
    })
  })

  describe("GET /api/internal/shop/cuotas", () => {
    it("401 sin secreto o con secreto incorrecto", async () => {
      expect((await interno.GET(internoReq(`?tenant=${TENANT_A}`, null))).status).toBe(401)
      expect((await interno.GET(internoReq(`?tenant=${TENANT_A}`, "Bearer otro"))).status).toBe(401)
    })

    it("400 sin tenant; 404 tenant inexistente (busca por tenants.id, no aiTenantId)", async () => {
      expect((await interno.GET(internoReq(""))).status).toBe(400)
      expect((await interno.GET(internoReq("?tenant=no-existe"))).status).toBe(404)
      expect((await interno.GET(internoReq(`?tenant=ai-${TENANT_A}`))).status).toBe(404)
    })

    it("200 vacío válido", async () => {
      const res = await interno.GET(internoReq(`?tenant=${TENANT_A}`))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(validarJsonSchema(schema, json)).toEqual([])
      expect(json).toMatchObject({ version: "v1", tenant: TENANT_A, medios: [], opciones: [] })
    })

    it("200 valida contra el schema, sólo activos y sin datos de otro tenant", async () => {
      const visa = (await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa" })).json.medio.id
      const amex = (await crearMedio({ proveedor: "mercadopago", codigoProveedor: "amex", nombre: "Amex", activo: false, orden: 2 })).json.medio.id
      await crearOpcion({ paymentMethodId: visa, cuotas: 6, sinInteres: true, montoMinimo: "150000.50", vigenteDesde: "2026-09-01", vigenteHasta: "2026-09-30" })
      await crearOpcion({ paymentMethodId: visa, cuotas: 12, activo: false })
      await crearOpcion({ paymentMethodId: amex, cuotas: 3 })

      login(adminB, TENANT_B)
      const visaB = (await crearMedio({ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa B" }, TENANT_B)).json.medio.id
      await crearOpcion({ paymentMethodId: visaB, cuotas: 18 }, TENANT_B)

      const res = await interno.GET(internoReq(`?tenant=${TENANT_A}`))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(validarJsonSchema(schema, json)).toEqual([])
      expect(json.medios).toEqual([{ id: visa, proveedor: "mercadopago", codigo: "visa", nombre: "Visa", activo: true, orden: 0 }])
      expect(json.opciones).toEqual([
        {
          id: expect.any(String),
          medioId: visa,
          cuotas: 6,
          sinInteres: true,
          montoMinimo: 150000.5,
          vigenteDesde: "2026-09-01",
          vigenteHasta: "2026-09-30",
          activo: true,
        },
      ])
    })
  })
})
