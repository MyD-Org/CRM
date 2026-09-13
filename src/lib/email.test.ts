import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const sendMock = vi.hoisted(() => vi.fn())

vi.mock("resend", () => ({
  Resend: class FakeResend {
    emails = { send: sendMock }
  },
}))

import { sendEmail } from "@/lib/email"
import type { TenantConfig } from "@/lib/tenants"

const tenant: TenantConfig = {
  id: "tenant-a",
  name: "Empresa Demo",
  subtitle: "",
  logoPath: "/logos/tenant-a.svg",
  alegraEmail: "",
  alegraToken: "",
  alegraMock: true,
  whatsappNumber: "",
  resendFrom: "Portal Empresa Demo <portal@example.com>",
  receiptsEmail: "pagos@example.com",
  aiApiBaseUrl: "",
  aiApiKey: "",
  aiAgentId: "",
  aiTenantId: "",
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key_123"
  sendMock.mockReset()
  sendMock.mockResolvedValue({ data: { id: "mail-1" }, error: null })
})

afterEach(() => {
  delete process.env.RESEND_API_KEY
})

describe("sendEmail", () => {
  it("sin opts: payload idéntico al de siempre y sin 2º argumento", async () => {
    const ok = await sendEmail(tenant, "cliente@example.com", "Hola", "<p>Hola</p>")
    expect(ok).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0]).toHaveLength(1) // sin 2º argumento
    expect(sendMock.mock.calls[0]![0]).toEqual({
      from: "Portal Empresa Demo <portal@example.com>",
      to: "cliente@example.com",
      subject: "Hola",
      html: "<p>Hola</p>",
    })
  })

  it("sin opts con text: incluye text como antes", async () => {
    await sendEmail(tenant, "cliente@example.com", "Hola", "<p>Hola</p>", "Hola en texto")
    expect(sendMock.mock.calls[0]![0]).toEqual({
      from: "Portal Empresa Demo <portal@example.com>",
      to: "cliente@example.com",
      subject: "Hola",
      html: "<p>Hola</p>",
      text: "Hola en texto",
    })
  })

  it("con opts: pasa from, replyTo, attachments, tags e idempotencyKey", async () => {
    const attachment = { filename: "comprobante.pdf", content: Buffer.from([1, 2, 3]), contentType: "application/pdf" }
    const ok = await sendEmail(tenant, "pagos@example.com", "Comprobante", "<p>Ver</p>", undefined, {
      from: "Empresa Demo · Comprobantes <comprobantes@example.com>",
      replyTo: "cliente@example.com",
      attachments: [attachment],
      tags: [
        { name: "type", value: "payment_receipt" },
        { name: "tenant", value: "tenant-a" },
      ],
      idempotencyKey: "payment-receipt/abc/1",
    })
    expect(ok).toBe(true)
    expect(sendMock).toHaveBeenCalledWith(
      {
        from: "Empresa Demo · Comprobantes <comprobantes@example.com>",
        to: "pagos@example.com",
        subject: "Comprobante",
        html: "<p>Ver</p>",
        replyTo: "cliente@example.com",
        attachments: [attachment],
        tags: [
          { name: "type", value: "payment_receipt" },
          { name: "tenant", value: "tenant-a" },
        ],
      },
      { idempotencyKey: "payment-receipt/abc/1" },
    )
  })

  it("opts parcial: solo agrega las claves presentes", async () => {
    await sendEmail(tenant, "pagos@example.com", "Comprobante", "<p>Ver</p>", "Ver", { replyTo: "cliente@example.com" })
    expect(sendMock.mock.calls[0]![0]).toEqual({
      from: "Portal Empresa Demo <portal@example.com>",
      to: "pagos@example.com",
      subject: "Comprobante",
      html: "<p>Ver</p>",
      text: "Ver",
      replyTo: "cliente@example.com",
    })
    expect(sendMock.mock.calls[0]).toHaveLength(1) // sin idempotencyKey ⇒ sin 2º argumento
  })

  it("sin RESEND_API_KEY: dry-run, false y no toca Resend", async () => {
    delete process.env.RESEND_API_KEY
    const ok = await sendEmail(tenant, "cliente@example.com", "Hola", "<p>Hola</p>")
    expect(ok).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("Resend rechaza ⇒ lanza", async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: "from no verificado" } })
    await expect(sendEmail(tenant, "cliente@example.com", "Hola", "<p>Hola</p>")).rejects.toThrow("from no verificado")
  })
})
