import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { getDb } from "@/db"
import { installmentOptions, paymentConfigVersions, paymentMethods } from "@/db/schema"
import { invalidateTenantRegistry } from "@/lib/tenants"
import { seedOperator, seedTenant, truncateAll } from "./helpers"
import { validarJsonSchema } from "../contracts/json-schema-lite"
import schema from "../contracts/cuotas/v2/schema.json"

// Integración de Medios de pago / Cuotas v2 (por proveedor + escalones). DB real (crm_test); se
// mockean iron-session y next/headers como en los tests de comprobantes. El ping al Shop usa el
// fetch global (stub) para probar que un Shop caído NO revierte el guardado.
//
// Nota: requireAdminPlus responde 404 (no 403) a un operator — política del guard del proyecto
// para no filtrar existencia.

let session: Record<string, unknown>

vi.mock("next/headers", () => ({
  cookies: async () => ({}),
  headers: async () => new Headers({ "x-tenant-id": "tenant-a" }),
}))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))

const proveedores = await import("@/app/api/admin/cuotas/proveedores/route")
const proveedorId = await import("@/app/api/admin/cuotas/proveedores/[id]/route")
const escalones = await import("@/app/api/admin/cuotas/escalones/route")
const escalonId = await import("@/app/api/admin/cuotas/escalones/[id]/route")
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

async function crearProveedor(body: Record<string, unknown>, host = TENANT_A) {
  const res = await proveedores.POST(req("/api/admin/cuotas/proveedores", { body, host }))
  return { res, json: await res.json() }
}

async function crearEscalon(body: Record<string, unknown>, host = TENANT_A) {
  const res = await escalones.POST(req("/api/admin/cuotas/escalones", { body, host }))
  return { res, json: await res.json() }
}

async function contrato() {
  const res = await interno.GET(internoReq(`?tenant=${TENANT_A}`))
  return { res, json: await res.json() }
}

/** Medio v1 por marca, cargado antes de v2: tiene que ignorarse en todo. */
async function seedMedioLegacy(tenantId: string) {
  const [medio] = await getDb()
    .insert(paymentMethods)
    .values({ tenantId, proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa" })
    .returning()
  await getDb()
    .insert(installmentOptions)
    .values({ tenantId, paymentMethodId: medio!.id, cuotas: 18, sinInteres: true, montoMinimo: "0", vigenteDesde: "2026-09-01" })
  return medio!.id
}

const fetchMock = vi.fn()

let adminA: string
let operatorA: string
let adminB: string

describe("cuotas v2: rutas admin e interna", () => {
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
    vi.stubEnv("SHOP_CRM_SECRET", SECRET)
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
      expect((await proveedores.GET(req("/api/admin/cuotas/proveedores"))).status).toBe(401)
      expect((await escalones.POST(req("/api/admin/cuotas/escalones", { body: {} }))).status).toBe(401)
    })

    it("operator → 404 en lecturas y escrituras, sin persistir", async () => {
      login(operatorA)
      const res = await proveedores.POST(req("/api/admin/cuotas/proveedores", { body: { proveedor: "mercadopago" } }))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(NOT_FOUND_BODY)
      expect((await escalones.GET(req("/api/admin/cuotas/escalones"))).status).toBe(404)
      expect(await getDb().select().from(paymentMethods)).toHaveLength(0)
    })
  })

  describe("proveedores", () => {
    it("alta con nombre derivado y código fijo; duplicado → 422; otro tenant sí puede", async () => {
      const { res, json } = await crearProveedor({ proveedor: "mercadopago", nombre: "Trucho", codigoProveedor: "visa", tenantId: TENANT_B })
      expect(res.status).toBe(201)
      expect(json).toEqual({
        ok: true,
        propagado: false,
        proveedor: { id: expect.any(String), proveedor: "mercadopago", nombre: "Mercado Pago", activo: true, orden: 0 },
      })

      const [row] = await getDb().select().from(paymentMethods)
      expect(row).toMatchObject({ tenantId: TENANT_A, codigoProveedor: "credito" })

      const dup = await crearProveedor({ proveedor: "mercadopago" })
      expect(dup.res.status).toBe(422)
      expect(dup.json).toMatchObject({ code: "duplicado", campo: "proveedor" })

      login(adminB, TENANT_B)
      expect((await crearProveedor({ proveedor: "mercadopago" }, TENANT_B)).res.status).toBe(201)

      login(adminA)
      const list = await (await proveedores.GET(req("/api/admin/cuotas/proveedores"))).json()
      expect(list.proveedores).toHaveLength(1)
    })

    it("proveedor fuera de la lista → 422 con campo", async () => {
      const { res, json } = await crearProveedor({ proveedor: "visa" })
      expect(res.status).toBe(422)
      expect(json).toMatchObject({ code: "invalid", campo: "proveedor" })
    })

    it("medios v1 por marca no se listan ni se editan", async () => {
      const legacy = await seedMedioLegacy(TENANT_A)
      const list = await (await proveedores.GET(req("/api/admin/cuotas/proveedores"))).json()
      expect(list.proveedores).toEqual([])
      const patch = await proveedorId.PATCH(req(`/api/admin/cuotas/proveedores/${legacy}`, { method: "PATCH", body: { activo: false } }), idParams(legacy))
      expect(patch.status).toBe(404)
      expect((await (await escalones.GET(req("/api/admin/cuotas/escalones"))).json()).escalones).toEqual([])
    })

    it("PATCH desactiva; de otro tenant o id basura → 404", async () => {
      const { json } = await crearProveedor({ proveedor: "mercadopago" })
      const id = json.proveedor.id as string

      const ok = await proveedorId.PATCH(req(`/api/admin/cuotas/proveedores/${id}`, { method: "PATCH", body: { activo: false } }), idParams(id))
      expect(ok.status).toBe(200)
      expect((await ok.json()).proveedor).toMatchObject({ activo: false, nombre: "Mercado Pago" })

      login(adminB, TENANT_B)
      const ajeno = await proveedorId.PATCH(req(`/api/admin/cuotas/proveedores/${id}`, { method: "PATCH", body: { activo: true }, host: TENANT_B }), idParams(id))
      expect(ajeno.status).toBe(404)
      expect(await ajeno.json()).toEqual(NOT_FOUND_BODY)
      const basura = await proveedorId.PATCH(req(`/api/admin/cuotas/proveedores/x`, { method: "PATCH", body: {}, host: TENANT_B }), idParams("x"))
      expect(basura.status).toBe(404)

      const [row] = await getDb().select().from(paymentMethods).where(eq(paymentMethods.id, id))
      expect(row?.activo).toBe(false)
    })
  })

  describe("escalones", () => {
    let mp: string

    beforeEach(async () => {
      mp = (await crearProveedor({ proveedor: "mercadopago" })).json.proveedor.id
    })

    it("crear hasta 6 cuotas desde 180.000 (campos v1 en default)", async () => {
      const { res, json } = await crearEscalon({ proveedorId: mp, cuotasMax: 6, montoMinimo: "180000", sinInteres: true })
      expect(res.status).toBe(201)
      expect(json).toEqual({
        ok: true,
        propagado: false,
        escalon: { id: expect.any(String), proveedorId: mp, cuotasMax: 6, montoMinimo: "180000.00", activo: true, updatedAt: expect.any(String) },
      })
      const [row] = await getDb().select().from(installmentOptions)
      expect(row).toMatchObject({ cuotas: 6, sinInteres: false, vigenteDesde: null, vigenteHasta: null, updatedBy: adminA, tenantId: TENANT_A })
    })

    it("1 cuota es válido (CHECK 1..24 de la migración 0026)", async () => {
      expect((await crearEscalon({ proveedorId: mp, cuotasMax: 1 })).res.status).toBe(201)
    })

    it.each([
      [{ cuotasMax: 0 }, "cuotasMax"],
      [{ cuotasMax: 25 }, "cuotasMax"],
      [{ cuotasMax: 6, montoMinimo: -5 }, "montoMinimo"],
    ])("inválido %j → 422 y no persiste", async (extra, campo) => {
      const { res, json } = await crearEscalon({ proveedorId: mp, ...extra })
      expect(res.status).toBe(422)
      expect(json).toMatchObject({ code: "invalid", campo })
      expect(await getDb().select().from(installmentOptions)).toHaveLength(0)
    })

    it("mismo monto mínimo activo → 422; desactivado el primero → acepta", async () => {
      const primero = (await crearEscalon({ proveedorId: mp, cuotasMax: 3, montoMinimo: "180000" })).json.escalon.id as string

      const choque = await crearEscalon({ proveedorId: mp, cuotasMax: 6, montoMinimo: 180000 })
      expect(choque.res.status).toBe(422)
      expect(choque.json).toMatchObject({ code: "monto_repetido", campo: "montoMinimo", conId: primero })

      // Editar otro escalón hacia ese monto también choca.
      const otro = (await crearEscalon({ proveedorId: mp, cuotasMax: 12, montoMinimo: "500000" })).json.escalon.id as string
      const patchChoque = await escalonId.PATCH(
        req(`/api/admin/cuotas/escalones/${otro}`, { method: "PATCH", body: { montoMinimo: "180000.00" } }),
        idParams(otro),
      )
      expect(patchChoque.status).toBe(422)

      const off = await escalonId.PATCH(req(`/api/admin/cuotas/escalones/${primero}`, { method: "PATCH", body: { activo: false } }), idParams(primero))
      expect(off.status).toBe(200)
      expect((await crearEscalon({ proveedorId: mp, cuotasMax: 6, montoMinimo: 180000 })).res.status).toBe(201)
    })

    it("dos altas concurrentes con el mismo monto → sólo una persiste (advisory lock)", async () => {
      const [a, b] = await Promise.all([
        crearEscalon({ proveedorId: mp, cuotasMax: 12, montoMinimo: "300000" }),
        crearEscalon({ proveedorId: mp, cuotasMax: 18, montoMinimo: "300000" }),
      ])
      expect([a.res.status, b.res.status].sort()).toEqual([201, 422])
      expect(await getDb().select().from(installmentOptions)).toHaveLength(1)
    })

    it("no se cuelgan escalones de un medio v1 por marca → 404", async () => {
      const legacy = await seedMedioLegacy(TENANT_A)
      expect((await crearEscalon({ proveedorId: legacy, cuotasMax: 3 })).res.status).toBe(404)
    })

    it("aislamiento: tenant B no lista, no edita, no borra y no usa proveedores de A", async () => {
      const id = (await crearEscalon({ proveedorId: mp, cuotasMax: 3 })).json.escalon.id as string

      login(adminB, TENANT_B)
      const list = await (await escalones.GET(req("/api/admin/cuotas/escalones", { host: TENANT_B }))).json()
      expect(list.escalones).toEqual([])

      const patch = await escalonId.PATCH(req(`/api/admin/cuotas/escalones/${id}`, { method: "PATCH", body: { cuotasMax: 4 }, host: TENANT_B }), idParams(id))
      expect(patch.status).toBe(404)
      expect(await patch.json()).toEqual(NOT_FOUND_BODY)

      const del = await escalonId.DELETE(req(`/api/admin/cuotas/escalones/${id}`, { method: "DELETE", host: TENANT_B }), idParams(id))
      expect(del.status).toBe(404)

      const conProveedorAjeno = await crearEscalon({ proveedorId: mp, cuotasMax: 6 }, TENANT_B)
      expect(conProveedorAjeno.res.status).toBe(404)

      const [row] = await getDb().select().from(installmentOptions).where(eq(installmentOptions.id, id))
      expect(row?.cuotas).toBe(3)
      expect(await getDb().select().from(paymentConfigVersions).where(eq(paymentConfigVersions.tenantId, TENANT_B))).toEqual([])
    })

    it("DELETE borra y mueve actualizadoEn del contrato", async () => {
      const id = (await crearEscalon({ proveedorId: mp, cuotasMax: 3 })).json.escalon.id as string
      const antes = (await contrato()).json.actualizadoEn as string

      await new Promise((r) => setTimeout(r, 15))
      const res = await escalonId.DELETE(req(`/api/admin/cuotas/escalones/${id}`, { method: "DELETE" }), idParams(id))
      expect(res.status).toBe(200)
      expect(await getDb().select().from(installmentOptions)).toHaveLength(0)

      const despues = (await contrato()).json.actualizadoEn as string
      expect(new Date(despues).getTime()).toBeGreaterThan(new Date(antes).getTime())
    })

    it("ping al Shop: caído → persiste igual con propagado:false; OK → propagado:true", async () => {
      vi.stubEnv("SHOP_INTERNAL_URL", "https://shop.test")
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
      const caido = await crearEscalon({ proveedorId: mp, cuotasMax: 3 })
      expect(caido.res.status).toBe(201)
      expect(caido.json.propagado).toBe(false)
      expect(await getDb().select().from(installmentOptions)).toHaveLength(1)

      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }))
      const ok = await crearEscalon({ proveedorId: mp, cuotasMax: 6, montoMinimo: "180000" })
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

    it("401 con INTERNAL_SECRET: la llave de ai-api no abre el endpoint del Shop", async () => {
      vi.stubEnv("INTERNAL_SECRET", "llave-de-ai-api")
      expect((await interno.GET(internoReq(`?tenant=${TENANT_A}`, "Bearer llave-de-ai-api"))).status).toBe(401)
    })

    it("400 sin tenant; 404 tenant inexistente (busca por tenants.id, no aiTenantId)", async () => {
      expect((await interno.GET(internoReq(""))).status).toBe(400)
      expect((await interno.GET(internoReq("?tenant=no-existe"))).status).toBe(404)
      expect((await interno.GET(internoReq(`?tenant=ai-${TENANT_A}`))).status).toBe(404)
    })

    it("200 vacío válido (medios v1 ignorados)", async () => {
      await seedMedioLegacy(TENANT_A)
      const { res, json } = await contrato()
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(validarJsonSchema(schema, json)).toEqual([])
      expect(json).toMatchObject({ version: "v2", tenant: TENANT_A, proveedores: [] })
    })

    it("200 valida contra el schema v2: sólo activos, por monto asc, sin datos de otro tenant", async () => {
      const mp = (await crearProveedor({ proveedor: "mercadopago" })).json.proveedor.id
      await seedMedioLegacy(TENANT_A)
      const e12 = (await crearEscalon({ proveedorId: mp, cuotasMax: 12, montoMinimo: "500000.50" })).json.escalon.id
      const e3 = (await crearEscalon({ proveedorId: mp, cuotasMax: 3 })).json.escalon.id
      await crearEscalon({ proveedorId: mp, cuotasMax: 18, montoMinimo: "900000", activo: false })
      const e6 = (await crearEscalon({ proveedorId: mp, cuotasMax: 6, montoMinimo: "180000" })).json.escalon.id

      login(adminB, TENANT_B)
      const mpB = (await crearProveedor({ proveedor: "mercadopago" }, TENANT_B)).json.proveedor.id
      await crearEscalon({ proveedorId: mpB, cuotasMax: 24 }, TENANT_B)

      const { res, json } = await contrato()
      expect(res.status).toBe(200)
      expect(validarJsonSchema(schema, json)).toEqual([])
      expect(json.proveedores).toEqual([
        {
          id: mp,
          proveedor: "mercadopago",
          nombre: "Mercado Pago",
          activo: true,
          orden: 0,
          escalones: [
            { id: e3, cuotasMax: 3, montoMinimo: 0 },
            { id: e6, cuotasMax: 6, montoMinimo: 180000 },
            { id: e12, cuotasMax: 12, montoMinimo: 500000.5 },
          ],
        },
      ])
    })

    it("proveedor desactivado no viaja", async () => {
      const mp = (await crearProveedor({ proveedor: "mercadopago" })).json.proveedor.id
      await crearEscalon({ proveedorId: mp, cuotasMax: 3 })
      await proveedorId.PATCH(req(`/api/admin/cuotas/proveedores/${mp}`, { method: "PATCH", body: { activo: false } }), idParams(mp))
      const { json } = await contrato()
      expect(validarJsonSchema(schema, json)).toEqual([])
      expect(json.proveedores).toEqual([])
    })
  })
})
