import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * Red de seguridad del proxy. Cubre las dos propiedades de las que depende TODO el
 * aislamiento entre tenants, y que ya se rompieron una vez cada una:
 *
 * 1. `x-tenant-id` viaja como header de REQUEST (`NextResponse.next({ request })`), no
 *    de respuesta. Con `res.headers.set()` el valor no llega a los Route Handlers y el
 *    login no puede saber en qué tenant está. Los docs de Next 16 son explícitos sobre
 *    la diferencia (`node_modules/next/dist/docs/.../proxy.md`, "Setting Headers").
 *
 * 2. El `.set()` PISA el header que mande el cliente. Es lo único que hace confiable al
 *    header downstream: un `.append()` en un refactor futuro reabriría el bypass en
 *    silencio, porque `headers.get()` devolvería el primero de la lista.
 *
 * Estos tests fallan a propósito en `feat/admin-tenant-guard-phase*` mergeada sobre la
 * rama de Clerk hasta que el arreglo se rehaga dentro del callback de `clerkMiddleware()`:
 * allá el `NextResponse.next()` vive adentro del callback y este fix no aplica solo.
 */

vi.mock("@/lib/site-gate", () => ({
  checkSiteGate: vi.fn(async () => null),
}))

// El registro de tenants sale de la DB (`getTenantRegistry`). Acá no hay Postgres y no es lo
// que se está testeando: cortamos el acceso para que caiga a su fallback de env
// (`TENANT_IDS` / `{PREFIX}_DOMAINS`), que es lo que estos tests configuran.
vi.mock("@/db", () => ({
  getDb: () => {
    throw new Error("sin DB en unit tests")
  },
}))

const ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ENV }
  process.env.TENANT_IDS = "central-led,tevro"
  process.env.CENTRAL_LED_DOMAINS = "crm.centralled.com.ar"
  process.env.TEVRO_DOMAINS = "www.tevro.com.ar,tevro.com.ar"
  process.env.CENTRAL_LED_MOCK = "true"
  process.env.TEVRO_MOCK = "true"
  delete process.env.TENANT_OVERRIDE
  delete process.env.VERCEL_ENV
})

async function run(url: string, headers: Record<string, string>) {
  const { proxy } = await import("./proxy")
  const { NextRequest } = await import("next/server")
  const req = new NextRequest(new URL(url), { headers })
  return proxy(req)
}

describe("proxy — propagación del tenant", () => {
  it("pasa x-tenant-id como header de REQUEST, no de respuesta", async () => {
    const res = await run("https://crm.centralled.com.ar/admin/login", {
      host: "crm.centralled.com.ar",
    })

    // El header que importa es el que viaja hacia el server runtime. Next lo expone en
    // `x-middleware-override-headers` / `x-middleware-request-*` en la respuesta interna.
    const overridden = res.headers.get("x-middleware-override-headers") ?? ""
    expect(overridden).toContain("x-tenant-id")
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBe("central-led")
  })

  it("resuelve el tenant por el dominio propio de cada uno", async () => {
    const cl = await run("https://crm.centralled.com.ar/admin", { host: "crm.centralled.com.ar" })
    expect(cl.headers.get("x-middleware-request-x-tenant-id")).toBe("central-led")

    const tv = await run("https://www.tevro.com.ar/admin", { host: "www.tevro.com.ar" })
    expect(tv.headers.get("x-middleware-request-x-tenant-id")).toBe("tevro")
  })

  it("PISA el x-tenant-id que mande el cliente (no lo appendea)", async () => {
    const res = await run("https://crm.centralled.com.ar/admin", {
      host: "crm.centralled.com.ar",
      "x-tenant-id": "tevro", // intento de suplantación
    })

    const value = res.headers.get("x-middleware-request-x-tenant-id")
    expect(value).toBe("central-led")
    // Un `.append()` dejaría "tevro, central-led" o "central-led, tevro".
    expect(value).not.toContain(",")
    expect(value).not.toContain("tevro")
  })

  it("404 si el host no matchea ningún tenant conocido", async () => {
    const res = await run("https://desconocido.example.com/admin", {
      host: "desconocido.example.com",
    })
    expect(res.status).toBe(404)
  })
})

describe("proxy — TENANT_OVERRIDE", () => {
  it("NO honra el override en producción (si no, el guard entra en loop)", async () => {
    process.env.VERCEL_ENV = "production"
    process.env.TENANT_OVERRIDE = "tevro"

    const res = await run("https://crm.centralled.com.ar/admin", {
      host: "crm.centralled.com.ar",
    })

    // Gana el host, no el override.
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBe("central-led")
  })

  it("sí lo honra fuera de producción, donde *.vercel.app no matchea nada", async () => {
    process.env.VERCEL_ENV = "preview"
    process.env.TENANT_OVERRIDE = "central-led"

    const res = await run("https://crm-abc123.vercel.app/admin", {
      host: "crm-abc123.vercel.app",
    })

    expect(res.status).not.toBe(404)
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBe("central-led")
  })
})
