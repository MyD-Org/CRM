import { describe, it, expect, beforeEach, vi } from "vitest"
import type { NextRequest } from "next/server"

/**
 * Unit del IDOR de `assign` (Fase 4 de admin-tenant-guard).
 *
 * El test de integración hermano verifica el PATRÓN de query contra Postgres real, pero no
 * ejercita esta ruta: quitarle el filtro por tenant al handler no lo hace fallar. Este sí
 * corre el handler entero, que es donde vive el bug.
 *
 * El agujero original: `targetOperatorId = body.operatorId.trim()` tomaba cualquier UUID sin
 * verificar a qué tenant pertenece, así que un operador podía asignarle una conversación a un
 * usuario de otro tenant — que terminaba viendo, y recibiendo un push sobre, datos ajenos.
 */

const state = vi.hoisted(() => ({
  session: { userId: "yo", tenantId: "tenant-a" } as Record<string, unknown>,
  operatorRows: [] as Record<string, unknown>[],
  operatorWhere: undefined as unknown,
  exigeUuid: true,
  assignCalls: [] as unknown[][],
  pushCalls: [] as unknown[][],
}))

vi.mock("next/headers", () => ({ cookies: async () => ({}) }))
vi.mock("iron-session", () => ({ getIronSession: async () => state.session }))

vi.mock("@/db", () => ({
  getDb: () => ({
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: (cond: unknown) => {
          // Sin proyección de columnas → es el SELECT del tenant; con ella, el del operador.
          if (!cols) {
            return Promise.resolve([
              { id: "tenant-a", aiTenantId: "ai-a", aiApiUrl: "http://ai.test" },
            ])
          }
          state.operatorWhere = cond
          // Postgres real: `admin_users.id` es uuid, así que comparar contra un string que
          // no lo sea levanta 22P02 y la ruta devolvería 500. El mock lo imita para que la
          // validación de forma previa a la query sea verificable.
          const valores = valoresDeLaCondicion(cond)
          const parece = valores.some((v) => /^[0-9a-f-]{20,}$/i.test(v))
          if (valores.some((v) => v === "no-soy-un-uuid") || (!parece && state.exigeUuid)) {
            const e = new Error('invalid input syntax for type uuid') as Error & { code: string }
            e.code = "22P02"
            return Promise.reject(e)
          }
          return Promise.resolve(state.operatorRows)
        },
      }),
    }),
  }),
}))

vi.mock("@/lib/inbox-api", () => ({
  listConversations: async () => [{ id: "conv-1", status: "open", contact: "Cliente" }],
}))

vi.mock("@/lib/assignment", () => ({
  assignInCrm: async (...args: unknown[]) => {
    state.assignCalls.push(args)
  },
  availableOperators: async () => [{ id: "op-de-a" }],
  getAssignments: async () => [],
  loadFromAssignments: () => new Map(),
  pickLeastLoaded: (ops: { id: string }[]) => ops[0],
}))

vi.mock("@/lib/push", () => ({
  sendPushToOperator: async (...args: unknown[]) => {
    state.pushCalls.push(args)
  },
}))

async function post(body: unknown) {
  vi.resetModules()
  const { POST } = await import("./route")
  const req = { json: async () => body } as unknown as NextRequest
  return POST(req, { params: Promise.resolve({ id: "conv-1" }) })
}

beforeEach(() => {
  state.session = { userId: "yo", tenantId: "tenant-a" }
  state.operatorRows = []
  state.operatorWhere = undefined
  state.assignCalls = []
  state.pushCalls = []
})

/**
 * Junta los valores literales de una condición de drizzle. Los nodos son CÍCLICOS
 * (`table` referencia columnas que referencian la tabla), así que sin el WeakSet
 * esto revienta el stack.
 */
function valoresDeLaCondicion(node: unknown, vistos = new WeakSet<object>()): string[] {
  if (typeof node === "string") return [node]
  if (!node || typeof node !== "object") return []
  if (vistos.has(node)) return []
  vistos.add(node)
  return Object.values(node as Record<string, unknown>).flatMap((v) =>
    valoresDeLaCondicion(v, vistos),
  )
}

describe("assign — aislamiento del operatorId", () => {
  it("asigna a un operador del propio tenant", async () => {
    state.operatorRows = [{ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", passwordHash: "hash" }]

    const res = await post({ operatorId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" })

    expect(res.status).toBe(200)
    expect(state.assignCalls).toHaveLength(1)
  })

  it("la query del operador va scopeada por tenant (el IDOR)", async () => {
    state.operatorRows = [{ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", passwordHash: "hash" }]

    await post({ operatorId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" })

    // El aserto duro: el tenant de la sesión tiene que estar EN la condición. Si el filtro
    // se cae, el mock devuelve la fila igual y la ruta asigna un operador ajeno.
    const valores = valoresDeLaCondicion(state.operatorWhere)
    expect(valores).toContain("tenant-a")
    expect(valores).toContain("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb")
  })

  it("404, sin asignar ni notificar, cuando la query no trae fila", async () => {
    state.operatorRows = []

    const res = await post({ operatorId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" })

    expect(res.status).toBe(404)
    expect(state.assignCalls).toHaveLength(0)
    expect(state.pushCalls).toHaveLength(0)
  })

  it("404 —no 500— si el operatorId no tiene forma de UUID", async () => {
    const res = await post({ operatorId: "no-soy-un-uuid" })

    // Un 500 (por el 22P02 de Postgres) distinguiría "mal formado" de "de otro tenant"
    // y serviría de oráculo para enumerar. Mismo 404 para los dos.
    expect(res.status).toBe(404)
    expect(state.assignCalls).toHaveLength(0)
  })

  it("404 si la cuenta existe pero es una invitación pendiente", async () => {
    state.operatorRows = [{ id: "cccccccc-3333-4333-8333-cccccccccccc", passwordHash: null }]

    const res = await post({ operatorId: "cccccccc-3333-4333-8333-cccccccccccc" })

    expect(res.status).toBe(404)
    expect(state.assignCalls).toHaveLength(0)
  })

  it("least-loaded sigue funcionando y elige dentro del tenant", async () => {
    const res = await post({ strategy: "least-loaded" })

    expect(res.status).toBe(200)
    expect(state.assignCalls).toHaveLength(1)
  })
})
