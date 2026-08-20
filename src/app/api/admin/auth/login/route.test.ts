import { describe, it, expect, beforeEach, vi } from "vitest"
import type { NextRequest } from "next/server"
import { hashPassword } from "@/lib/admin-crypto"

// Unit del login sellado por tenant (Fase 2 de admin-tenant-guard).
// Sin DB: se mockea `@/db` con un fake que devuelve filas fijas y captura la
// condición del `where`, así se puede assertear que la query va scopeada por
// (email, tenant) sin levantar Postgres. El rate limit es un Map en memoria del
// módulo, así que cada test recarga el módulo para arrancar con el contador limpio.

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  wheres: [] as unknown[],
  session: {} as Record<string, unknown>,
  saved: 0,
}))

vi.mock("next/headers", () => ({ cookies: async () => ({}) }))

vi.mock("iron-session", () => ({
  getIronSession: async () => {
    state.session.save = async () => {
      state.saved += 1
    }
    return state.session
  },
}))

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          state.wheres.push(cond)
          return Promise.resolve(state.rows)
        },
      }),
    }),
  }),
}))

// Spy sobre `verifyPassword` conservando la implementación real: el aserto duro del
// requisito de timing es que se invoque TAMBIÉN cuando no hay fila.
vi.mock("@/lib/admin-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-crypto")>()
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) }
})

type VerifySpy = ReturnType<typeof vi.fn> & { mock: { calls: [string, string][] } }

async function loadRoute() {
  vi.resetModules()
  process.env.TENANT_IDS = "tenant-a,tenant-b"
  delete process.env.TENANT_OVERRIDE
  delete process.env.VERCEL_ENV
  const route = await import("./route")
  const crypto = await import("@/lib/admin-crypto")
  const verifyPassword = crypto.verifyPassword as unknown as VerifySpy
  verifyPassword.mockClear()
  return { POST: route.POST, verifyPassword }
}

function loginReq(host: string, email: string, password: string): NextRequest {
  return new Request(`http://${host}/api/admin/auth/login`, {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }) as unknown as NextRequest
}

/** Junta los valores de parámetros de una condición de drizzle (`and(eq(...), eq(...))`). */
function paramValues(node: unknown, out: unknown[] = [], seen = new WeakSet<object>()): unknown[] {
  if (!node || typeof node !== "object") return out
  if (seen.has(node)) return out // los nodos de drizzle tienen referencias cíclicas
  seen.add(node)
  const obj = node as Record<string, unknown>
  if ("value" in obj && typeof obj.value !== "object") out.push(obj.value)
  for (const v of Object.values(obj)) paramValues(v, out, seen)
  return out
}

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Ana",
    email: "ana@ejemplo.com",
    role: "admin",
    tenantId: "tenant-a",
    ...overrides,
  }
}

beforeEach(() => {
  state.rows = []
  state.wheres = []
  state.session = {}
  state.saved = 0
})

describe("login: query scopeada por tenant del host", () => {
  it("filtra por email AND tenant del host, no solo por email", async () => {
    const { POST } = await loadRoute()
    state.rows = []

    await POST(loginReq("tenant-a.example.com", "Ana@Ejemplo.com", "loquesea"))

    expect(state.wheres).toHaveLength(1)
    const values = paramValues(state.wheres[0])
    expect(values).toContain("ana@ejemplo.com")
    expect(values).toContain("tenant-a")
  })

  it("emite la sesión con el tenant del host y el rol de la fila", async () => {
    const { POST } = await loadRoute()
    const passwordHash = await hashPassword("secreta")
    state.rows = [activeUser({ passwordHash, role: "operator" })]

    const res = await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))

    expect(res.status).toBe(200)
    expect(state.saved).toBe(1)
    expect(state.session.tenantId).toBe("tenant-a")
    expect(state.session.role).toBe("operator")
    expect(state.session.userId).toBe("11111111-1111-4111-8111-111111111111")
  })

  it("host no resoluble: 401 genérico sin consultar credenciales", async () => {
    const { POST } = await loadRoute()
    state.rows = [activeUser({ passwordHash: await hashPassword("secreta") })]

    const res = await POST(loginReq("atacante.example.com", "ana@ejemplo.com", "secreta"))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Credenciales incorrectas" })
    expect(state.wheres).toHaveLength(0)
    expect(state.saved).toBe(0)
  })

  it("host no resoluble: el fallo no consume la cubeta de rate limit de ningún tenant", async () => {
    const { POST } = await loadRoute()
    const passwordHash = await hashPassword("secreta")
    state.rows = [activeUser({ passwordHash })]

    for (let i = 0; i < 6; i++) {
      await POST(loginReq("atacante.example.com", "ana@ejemplo.com", "mala"))
    }

    const res = await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))
    expect(res.status).toBe(200)
  })
})

describe("login: timing parejo con hash dummy", () => {
  it("corre verifyPassword también cuando no hay fila para (email, tenant)", async () => {
    const { POST, verifyPassword } = await loadRoute()
    state.rows = [] // cuenta inexistente, o existente en otro tenant

    const res = await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "secreta"))

    expect(res.status).toBe(401)
    expect(verifyPassword).toHaveBeenCalledTimes(1)
    expect(verifyPassword.mock.calls[0][0]).toBe("secreta")
  })

  it("corre verifyPassword también con la cuenta sin contraseña (invitación pendiente)", async () => {
    const { POST, verifyPassword } = await loadRoute()
    state.rows = [activeUser({ passwordHash: null })]

    const res = await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Credenciales incorrectas" })
    expect(verifyPassword).toHaveBeenCalledTimes(1)
  })

  it("el hash dummy está BIEN FORMADO: salt + hash de 64 bytes, o verifyPassword corta antes de scrypt", async () => {
    const { POST, verifyPassword } = await loadRoute()
    state.rows = []

    await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))

    const dummy = verifyPassword.mock.calls[0][1]
    const [salt, hash] = dummy.split(":")
    // `verifyPassword` hace `stored.split(":")` y devuelve false SIN correr scrypt si
    // falta cualquiera de las dos partes; y corta antes del timingSafeEqual si el hash
    // no mide 64 bytes. Un dummy que no cumpla esto no empareja ningún tiempo.
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
    expect(hash).toMatch(/^[0-9a-f]{128}$/)
    expect(Buffer.from(hash, "hex")).toHaveLength(64)
  })

  it("los tres casos de fallo devuelven el mismo status y el mismo cuerpo", async () => {
    const { POST } = await loadRoute()
    const passwordHash = await hashPassword("secreta")

    state.rows = [] // (a) email inexistente
    const inexistente = await POST(loginReq("tenant-b.example.com", "nadie@ejemplo.com", "x"))

    state.rows = [] // (b) existe, pero en otro tenant → la query scopeada no lo trae
    const otroTenant = await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "secreta"))

    state.rows = [activeUser({ passwordHash, tenantId: "tenant-b" })] // (c) contraseña mala
    const passMala = await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "mala"))

    for (const res of [inexistente, otroTenant, passMala]) {
      expect(res.status).toBe(401)
      expect(await res.text()).toBe(JSON.stringify({ error: "Credenciales incorrectas" }))
    }
  })
})

describe("login: rate limit por (tenant, email)", () => {
  it("5 fallos en tenant-a no bloquean el login en tenant-b", async () => {
    const { POST } = await loadRoute()
    const passwordHash = await hashPassword("secreta")

    state.rows = []
    for (let i = 0; i < 5; i++) {
      await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "mala"))
    }

    state.rows = [activeUser({ passwordHash, tenantId: "tenant-b" })]
    const res = await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "secreta"))

    expect(res.status).toBe(200)
  })

  it("el sexto intento en el mismo tenant da 429 incluso con la contraseña correcta", async () => {
    const { POST } = await loadRoute()
    const passwordHash = await hashPassword("secreta")

    state.rows = []
    for (let i = 0; i < 5; i++) {
      await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "mala"))
    }

    state.rows = [activeUser({ passwordHash })]
    const res = await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))

    expect(res.status).toBe(429)
    expect(state.saved).toBe(0)
  })

  it("un login exitoso limpia solo la clave de su tenant", async () => {
    const { POST } = await loadRoute()
    const passwordHash = await hashPassword("secreta")

    state.rows = []
    for (let i = 0; i < 4; i++) {
      await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "mala"))
      await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "mala"))
    }

    // Éxito en tenant-a → resetea SU contador
    state.rows = [activeUser({ passwordHash })]
    expect((await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))).status).toBe(200)

    // tenant-b sigue con 4 fallos: el quinto lo bloquea
    state.rows = []
    await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "mala"))
    state.rows = [activeUser({ passwordHash, tenantId: "tenant-b" })]
    expect((await POST(loginReq("tenant-b.example.com", "ana@ejemplo.com", "secreta"))).status).toBe(429)

    // tenant-a arrancó de cero: sigue entrando
    state.rows = [activeUser({ passwordHash })]
    expect((await POST(loginReq("tenant-a.example.com", "ana@ejemplo.com", "secreta"))).status).toBe(200)
  })
})
