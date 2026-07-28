import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { seedTenant, seedOperator, truncateAll } from "./helpers"

// Tests de las rutas del inbox. Son proxies finos a la ai-api (que tiene sus propios tests de
// negocio), así que acá se verifica lo que es responsabilidad del CRM:
//   - que exijan sesión (401),
//   - que corten si el tenant no está configurado (503),
//   - que validen el body (400),
//   - y sobre todo que le pasen a la ai-api las credenciales del tenant DE LA SESIÓN, nunca
//     algo que venga del request. Ese es el pilar del aislamiento entre tenants.
//
// Se mockea la sesión y el cliente de inbox-api (con spies, para poder afirmar con qué se lo
// llamó); la DB y las rutas son las reales.

let session: Record<string, unknown>

vi.mock("next/headers", () => ({ cookies: async () => ({}) }))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))

const api = {
  listConversations: vi.fn(async () => [{ id: "c1" }]),
  getMessages: vi.fn(async () => [{ id: "m1" }]),
  getContact: vi.fn(async () => ({ end_user_id: "u1" })),
  getContactMessages: vi.fn(async () => ({ messages: [], next_cursor: null, has_more: false })),
  sendReply: vi.fn(async () => ({ ok: true })),
  setMode: vi.fn(async () => undefined),
  archiveConversation: vi.fn(async () => undefined),
  retryMessage: vi.fn(async () => ({ ok: true })),
  startAssist: vi.fn(async () => ({
    ok: true as boolean,
    session: { conversationId: "conv-assist", token: "tok", agentId: "ag1" },
    error: undefined as string | undefined,
  })),
  getBotStatus: vi.fn(async () => true),
  setBotStatus: vi.fn(async () => undefined),
}
vi.mock("@/lib/inbox-api", () => api)

const { GET: getBotStatusRoute, POST: postBotStatusRoute } = await import(
  "@/app/api/admin/inbox/bot-status/route"
)
const { GET: listConversationsRoute } = await import("@/app/api/admin/inbox/conversations/route")
const { GET: getMessagesRoute } = await import("@/app/api/admin/inbox/[id]/messages/route")
const { POST: replyRoute } = await import("@/app/api/admin/inbox/[id]/reply/route")
const { POST: modeRoute } = await import("@/app/api/admin/inbox/[id]/mode/route")
const { POST: archiveRoute } = await import("@/app/api/admin/inbox/[id]/archive/route")
const { POST: retryRoute } = await import("@/app/api/admin/inbox/[id]/messages/[messageId]/retry/route")
const { GET: getContactRoute } = await import("@/app/api/admin/inbox/contacts/[endUserId]/route")
const { GET: getContactMessagesRoute } = await import(
  "@/app/api/admin/inbox/contacts/[endUserId]/messages/route"
)
const { POST: assistRoute } = await import("@/app/api/admin/inbox/contacts/[endUserId]/assist/route")

const TENANT = "test-tenant"
const AI_TENANT = `ai-${TENANT}`
const AI_URL = "http://ai-api.test"
const CONV = "conv-1"

function loginAs(userId: string, role: "operator" | "admin" | "superadmin" = "operator") {
  session = { userId, role, tenantId: TENANT, name: "Ana Operadora", email: "a@x.com", save: async () => {} }
}
function logout() {
  session = {}
}

const req = (url = "http://localhost/x") => new NextRequest(url)
const jsonReq = (body: unknown) =>
  new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) })
const convParams = { params: Promise.resolve({ id: CONV }) }
const userParams = { params: Promise.resolve({ endUserId: "u1" }) }

describe("rutas del inbox", () => {
  let operador: string

  beforeEach(async () => {
    vi.clearAllMocks()
    await truncateAll()
    await seedTenant(TENANT)
    operador = await seedOperator(TENANT, { role: "operator", name: "Ana Operadora" })
    loginAs(operador)
  })

  describe("exigen sesión (401)", () => {
    beforeEach(() => logout())

    it.each([
      ["bot-status GET", () => getBotStatusRoute()],
      ["bot-status POST", () => postBotStatusRoute(jsonReq({ enabled: false }))],
      ["conversations", () => listConversationsRoute()],
      ["messages", () => getMessagesRoute(req(), convParams)],
      ["reply", () => replyRoute(jsonReq({ text: "hola" }), convParams)],
      ["mode", () => modeRoute(jsonReq({ mode: "human" }), convParams)],
      ["archive", () => archiveRoute(req(), convParams)],
      ["retry", () => retryRoute(req(), { params: Promise.resolve({ id: CONV, messageId: "m1" }) })],
      ["contacto", () => getContactRoute(req(), userParams)],
      ["mensajes del contacto", () => getContactMessagesRoute(req(), userParams)],
      ["assist", () => assistRoute(req(), userParams)],
    ])("%s → 401", async (_nombre, call) => {
      expect((await call()).status).toBe(401)
    })

    it("no llega a llamar a la ai-api", async () => {
      await replyRoute(jsonReq({ text: "hola" }), convParams)
      expect(api.sendReply).not.toHaveBeenCalled()
    })
  })

  describe("aislamiento por tenant", () => {
    it("usa las credenciales del tenant de la SESIÓN, no del request", async () => {
      await listConversationsRoute()
      expect(api.listConversations).toHaveBeenCalledWith(AI_URL, AI_TENANT)
    })

    it("responder pasa el tenant de la sesión y el texto recortado", async () => {
      await replyRoute(jsonReq({ text: "  hola  " }), convParams)
      expect(api.sendReply).toHaveBeenCalledWith(AI_URL, AI_TENANT, CONV, "hola")
    })

    it("si el tenant no está configurado corta con 503 y no llama a la ai-api", async () => {
      await truncateAll() // deja el tenant sin fila → sin aiApiUrl
      expect((await listConversationsRoute()).status).toBe(503)
      expect(api.listConversations).not.toHaveBeenCalled()
    })
  })

  describe("validación de body", () => {
    it("responder sin texto → 400", async () => {
      expect((await replyRoute(jsonReq({ text: "   " }), convParams)).status).toBe(400)
      expect(api.sendReply).not.toHaveBeenCalled()
    })

    it("mode con valor inválido → 400", async () => {
      expect((await modeRoute(jsonReq({ mode: "robot" }), convParams)).status).toBe(400)
      expect(api.setMode).not.toHaveBeenCalled()
    })

    it("bot-status con enabled no booleano → 400", async () => {
      expect((await postBotStatusRoute(jsonReq({ enabled: "si" }))).status).toBe(400)
      expect(api.setBotStatus).not.toHaveBeenCalled()
    })
  })

  describe("acciones del operador (camino feliz)", () => {
    it("lee el thread de una conversación", async () => {
      const res = await getMessagesRoute(req(), convParams)
      expect(res.status).toBe(200)
      expect(api.getMessages).toHaveBeenCalledWith(AI_URL, AI_TENANT, CONV)
    })

    it("toma la conversación en modo humano y manda su nombre para el aviso", async () => {
      const res = await modeRoute(jsonReq({ mode: "human" }), convParams)
      expect(res.status).toBe(200)
      expect(api.setMode).toHaveBeenCalledWith(AI_URL, AI_TENANT, CONV, "human", "Ana Operadora")
    })

    it("al devolver al bot no manda nombre de operador", async () => {
      await modeRoute(jsonReq({ mode: "bot" }), convParams)
      expect(api.setMode).toHaveBeenCalledWith(AI_URL, AI_TENANT, CONV, "bot", undefined)
    })

    it("archiva una conversación", async () => {
      expect((await archiveRoute(req(), convParams)).status).toBe(200)
      expect(api.archiveConversation).toHaveBeenCalledWith(AI_URL, AI_TENANT, CONV)
    })

    it("reintenta un mensaje que no se entregó", async () => {
      await retryRoute(req(), { params: Promise.resolve({ id: CONV, messageId: "m9" }) })
      expect(api.retryMessage).toHaveBeenCalledWith(AI_URL, AI_TENANT, CONV, "m9")
    })

    it("abre el copiloto sobre un contacto y devuelve lo que necesita el widget", async () => {
      const res = await assistRoute(req(), userParams)
      expect(res.status).toBe(200)
      expect(api.startAssist).toHaveBeenCalledWith(AI_URL, AI_TENANT, "u1")
      expect(await res.json()).toEqual({
        conversationId: "conv-assist",
        token: "tok",
        agentId: "ag1",
        baseUrl: "/ai-api", // rewrite same-origin: el token nunca sale a otro dominio
      })
    })

    it("404 si el contacto no existe en la ai-api", async () => {
      api.getContact.mockRejectedValueOnce(new Error("not found"))
      expect((await getContactRoute(req(), userParams)).status).toBe(404)
    })
  })

  // El copiloto traduce los errores de la ai-api a status HTTP para que el widget sepa si
  // mostrar "contacto inexistente", "falta configurar el agente" o un error genérico.
  describe("mapeo de errores del copiloto", () => {
    it.each([
      ["contact_not_found", 404],
      ["assist_agent_not_configured", 409],
      ["algo_inesperado", 502],
    ])("%s → %i", async (error, status) => {
      api.startAssist.mockResolvedValueOnce({ ok: false, session: undefined as never, error })
      const res = await assistRoute(req(), userParams)
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error })
    })
  })

  describe("kill switch del bot", () => {
    // DECISIÓN DE PRODUCTO: el kill switch queda disponible para CUALQUIER usuario logueado,
    // incluido un operador, para que funcione como freno de emergencia 24/7 aunque no haya un
    // admin disponible. Este test fija ese comportamiento a propósito: si algún día se decide
    // restringirlo a admin/superadmin, debe fallar acá y actualizarse conscientemente.
    it("un operador PUEDE apagar el bot de todo el tenant (decisión deliberada)", async () => {
      loginAs(operador, "operator")
      const res = await postBotStatusRoute(jsonReq({ enabled: false }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ botEnabled: false })
      expect(api.setBotStatus).toHaveBeenCalledWith(AI_URL, AI_TENANT, false)
    })

    it("un operador puede volver a encenderlo", async () => {
      await postBotStatusRoute(jsonReq({ enabled: true }))
      expect(api.setBotStatus).toHaveBeenCalledWith(AI_URL, AI_TENANT, true)
    })

    it("cualquiera puede consultar si el bot está activo", async () => {
      const res = await getBotStatusRoute()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ botEnabled: true })
    })
  })
})
