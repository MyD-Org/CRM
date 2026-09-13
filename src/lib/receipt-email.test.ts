import { describe, it, expect } from "vitest"
import {
  buildReceiptEmail,
  formatFromAddress,
  escapeHtml,
  ATTACH_MAX_BYTES,
  RECEIPT_EMAIL_SUBJECT_PREFIX,
  type ReceiptEmailInput,
} from "@/lib/receipt-email"

function input(overrides: Partial<ReceiptEmailInput> = {}): ReceiptEmailInput {
  return {
    tenantName: "Empresa Demo",
    receipt: {
      id: "3f6f8d6e-2f6b-4a1c-9e5d-7b2c4a6d8e0f",
      razonsocial: "Cliente Ejemplo SA",
      cuit: "30-71234567-8",
      codigocliente: "123",
      amount: "150000.50",
      paidOn: "2026-09-01",
      method: "transferencia",
      notes: null,
      fileMime: "application/pdf",
      fileSize: 3 * 1024 * 1024,
      submittedAt: new Date("2026-09-12T15:00:00.000Z"),
    },
    adminUrl: "https://tenant-a.example.com/admin/comprobantes?id=3f6f8d6e-2f6b-4a1c-9e5d-7b2c4a6d8e0f",
    attachmentIncluded: true,
    ...overrides,
  }
}

describe("ATTACH_MAX_BYTES", () => {
  it("10 MiB exactos", () => {
    expect(ATTACH_MAX_BYTES).toBe(10485760)
  })
})

describe("escapeHtml", () => {
  it("escapa los 5 caracteres", () => {
    expect(escapeHtml(`<a href="x'">&'`)).toBe(`&lt;a href=&quot;x&#39;&quot;&gt;&amp;&#39;`)
  })
})

describe("formatFromAddress", () => {
  it('"Nombre del tenant · Comprobantes" <mail>', () => {
    expect(formatFromAddress("Empresa Demo · Comprobantes", "comprobantes@example.com")).toBe(
      '"Empresa Demo · Comprobantes" <comprobantes@example.com>',
    )
  })

  it("quita comillas, ángulos y CR/LF del nombre; recorta a 64", () => {
    expect(formatFromAddress('Ro"bo<tito>\r\n', "a@example.com")).toBe('"Robotito" <a@example.com>')
    expect(formatFromAddress("x".repeat(100), "a@example.com")).toBe(`"${"x".repeat(64)}" <a@example.com>`)
  })
})

describe("buildReceiptEmail", () => {
  it("subject con prefijo exacto y formato de la spec", () => {
    const { subject } = buildReceiptEmail(input())
    expect(subject.startsWith("[Comprobante de pago] ")).toBe(true)
    expect(subject).toContain("Cliente Ejemplo SA")
    expect(subject).toContain("01/09/2026")
    expect(subject.length).toBeLessThanOrEqual(200)
  })

  it("escapa <img onerror> en razón social y <script> en notas", () => {
    const { html } = buildReceiptEmail(
      input({
        receipt: {
          ...input().receipt,
          razonsocial: "ACME <img src=x onerror=alert(1)>",
          notes: "</p><script>x</script>",
        },
      }),
    )
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;")
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).not.toContain("<script>x</script>")
  })

  it("razón social con CRLF + Bcc: subject en una sola línea que empieza con el prefijo", () => {
    const { subject } = buildReceiptEmail(
      input({ receipt: { ...input().receipt, razonsocial: "ACME SA\r\nBcc: otro@example.com" } }),
    )
    expect(subject.startsWith(`${RECEIPT_EMAIL_SUBJECT_PREFIX} `)).toBe(true)
    expect(subject).not.toContain("\r")
    expect(subject).not.toContain("\n")
  })

  it("10485760 bytes ⇒ adjunto ('Va adjunto.'); +1 byte ⇒ aviso con tamaño", () => {
    const adjunta = buildReceiptEmail(
      input({ receipt: { ...input().receipt, fileSize: ATTACH_MAX_BYTES }, attachmentIncluded: true }),
    )
    expect(adjunta.html).toContain("Va adjunto.")
    expect(adjunta.text).toContain("Va adjunto.")

    const grande = buildReceiptEmail(
      input({ receipt: { ...input().receipt, fileSize: ATTACH_MAX_BYTES + 1 }, attachmentIncluded: false }),
    )
    expect(grande.html).not.toContain("Va adjunto.")
    expect(grande.html).toContain("El archivo pesa")
    expect(grande.html).toContain("y no se adjunta")
    expect(grande.text).toContain("no se adjunta")
  })

  it("sin clientEmail no invita a responder; con clientEmail sí", () => {
    const sin = buildReceiptEmail(input({ clientEmail: null }))
    expect(sin.html).not.toContain("Respondé este mail")
    const con = buildReceiptEmail(input({ clientEmail: "cliente@example.com" }))
    expect(con.html).toContain("Respondé este mail para escribirle al cliente.")
  })

  it("link absoluto al admin con el id", () => {
    const { html, text } = buildReceiptEmail(input())
    expect(html).toContain('href="https://tenant-a.example.com/admin/comprobantes?id=3f6f8d6e-2f6b-4a1c-9e5d-7b2c4a6d8e0f"')
    expect(text).toContain("https://tenant-a.example.com/admin/comprobantes?id=3f6f8d6e-2f6b-4a1c-9e5d-7b2c4a6d8e0f")
  })

  it("método 'otro' muestra el detalle; convertido de HEIC se aclara", () => {
    const { html } = buildReceiptEmail(
      input({
        receipt: {
          ...input().receipt,
          method: "otro",
          methodOther: "depósito",
          fileMime: "image/jpeg",
          convertedFrom: "image/heic",
        },
      }),
    )
    expect(html).toContain("Otro (depósito)")
    expect(html).toContain("(convertido de image/heic)")
  })

  it("el texto plano lleva los datos sin etiquetas", () => {
    const { text } = buildReceiptEmail(input())
    expect(text).toContain("Cliente: Cliente Ejemplo SA")
    expect(text).toContain("Monto:")
    expect(text).not.toContain("<table")
  })
})
