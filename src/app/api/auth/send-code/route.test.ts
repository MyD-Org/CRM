import { describe, it, expect, vi } from "vitest"
import type { Cliente } from "@/types"

// Unit del envío del código de acceso al portal. Sin Alegra ni Resend: se mockean
// `@/lib/erp` (resolución del identificador) y `@/lib/email` (envío). El rate limit
// es un Map en memoria del módulo, así que cada test recarga el módulo para arrancar
// con la cuota limpia y usa un identificador propio.

const state = vi.hoisted(() => ({
  cliente: null as Cliente | null,
  sent: [] as { to: string; subject: string; html: string; text?: string }[],
  sendError: null as Error | null,
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

vi.mock("@/lib/tenant-context", () => ({
  getTenantConfig: async () => ({ id: "t1", name: "Avantec", resendFrom: "portal@tevro.com.ar" }),
}))

vi.mock("@/lib/erp", () => ({
  getClienteByIdentifier: async () => state.cliente,
}))

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>()
  return {
    ...actual,
    sendEmail: async (_t: unknown, to: string, subject: string, html: string, text?: string) => {
      if (state.sendError) throw state.sendError
      state.sent.push({ to, subject, html, text })
      return true
    },
  }
})

const baseCliente: Cliente = {
  codigocliente: "42",
  razonsocial: "ACME SRL",
  cuit: "20-12345678-9",
  email: "compras@acme.com",
  numerocuentacorriente: 42,
  tipoCuenta: "corriente",
  limitecredito: 0,
  deudatotal: 0,
  saldovencido: 0,
  saldoavencer: 0,
}

async function loadRoute() {
  vi.resetModules()
  state.cliente = { ...baseCliente }
  state.sent = []
  state.sendError = null
  state.session = {}
  state.saved = 0
  const route = await import("./route")
  return route.POST
}

function req(identifier: string) {
  return new Request("http://avantec.tevro.com.ar/api/auth/send-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier }),
  })
}

describe("POST /api/auth/send-code", () => {
  it("manda el código al email del contacto de Alegra, no al identificador tipeado", async () => {
    const POST = await loadRoute()
    const res = await POST(req("20-12345678-9"))

    expect(res.status).toBe(200)
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0].to).toBe("compras@acme.com")

    const body = await res.json()
    expect(body.sentTo).toBe("co*****@acme.com")
    // El código va en el mail, nunca en el cuerpo de la respuesta salvo devCode fuera de prod.
    expect(body.devCode).toMatch(/^\d{6}$/)
    expect(state.sent[0].html).toContain(body.devCode)
  })

  it("manda el código en formato detectable por el celular", async () => {
    const POST = await loadRoute()
    const body = await (await POST(req("20-12345678-9"))).json()
    const code = body.devCode
    const { subject, text, html } = state.sent[0]

    // El asunto lleva el código: es lo único que el celular ve en la notificación.
    expect(subject).toContain(code)
    // Parte en texto plano presente (la que parsean los detectores) con la frase gatillo.
    expect(text).toContain(`Tu código de verificación es ${code}`)
    // Los 6 dígitos van juntos: un separador o un espaciado que los parta rompe la detección.
    expect(text).not.toMatch(new RegExp(code.split("").join("[\\s-]")))
    expect(html).toContain(code)
  })

  it("guarda en la sesión el mismo código que se envió, con vencimiento futuro", async () => {
    const POST = await loadRoute()
    const res = await POST(req("20-12345678-9"))
    const body = await res.json()

    expect(state.saved).toBe(1)
    expect(state.session.otp).toBe(body.devCode)
    expect(state.session.identifier).toBe("20-12345678-9")
    expect(state.session.attempts).toBe(0)
    expect(state.session.otpExpiry as number).toBeGreaterThan(Date.now())
  })

  it("404 sin emitir código si el identificador no existe en el ERP", async () => {
    const POST = await loadRoute()
    state.cliente = null

    const res = await POST(req("99-99999999-9"))

    expect(res.status).toBe(404)
    expect(state.sent).toHaveLength(0)
    expect(state.saved).toBe(0)
  })

  it("409 si la cuenta existe pero no tiene email cargado", async () => {
    const POST = await loadRoute()
    state.cliente = { ...baseCliente, email: undefined }

    const res = await POST(req("20-12345678-9"))

    expect(res.status).toBe(409)
    expect(state.sent).toHaveLength(0)
    expect(state.saved).toBe(0)
  })

  it("502 sin sellar la sesión si Resend rechaza el envío", async () => {
    const POST = await loadRoute()
    state.sendError = new Error("domain not verified")

    const res = await POST(req("20-12345678-9"))

    expect(res.status).toBe(502)
    // Sin cookie sellada: el usuario no queda esperando un código que nunca salió.
    expect(state.saved).toBe(0)
  })

  it("429 tras 5 envíos al mismo identificador dentro de la ventana", async () => {
    const POST = await loadRoute()

    for (let i = 0; i < 5; i++) {
      expect((await POST(req("20-11111111-1"))).status).toBe(200)
    }
    const res = await POST(req("20-11111111-1"))

    expect(res.status).toBe(429)
    expect(state.sent).toHaveLength(5)
  })

  it("400 si el identificador es muy corto", async () => {
    const POST = await loadRoute()
    const res = await POST(req("ab"))

    expect(res.status).toBe(400)
    expect(state.sent).toHaveLength(0)
  })
})
