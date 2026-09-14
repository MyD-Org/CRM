// Tests unitarios de la validación del body de "Cargar en Alegra" (parseLoadBody y
// validateAllocations). Sin HTTP ni DB: la ruta solo orquesta. Datos 100% ficticios.

import { describe, expect, it } from "vitest"
import { parseLoadBody, validateAllocations, type OpenInvoiceForValidation } from "@/lib/receipt-alegra-load"

const NOW = new Date("2026-09-13T12:00:00.000Z")

const FACTURAS: OpenInvoiceForValidation[] = [
  { alegraId: "101", number: "FV-1-0001", balance: 800 },
  { alegraId: "102", number: "FV-1-0002", balance: 1200.5 },
]

function bodyValido(overrides: Record<string, unknown> = {}) {
  return {
    method: "transfer",
    bankAccountId: "7",
    paidOn: "2026-09-10",
    allocations: [
      { invoiceId: "101", amount: "800.00" },
      { invoiceId: "102", amount: "400.00" },
    ],
    ...overrides,
  }
}

describe("parseLoadBody", () => {
  it("body válido ⇒ ok con los valores normalizados", () => {
    const res = parseLoadBody(bodyValido(), NOW)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.method).toBe("transfer")
    expect(res.value.bankAccountId).toBe("7")
    expect(res.value.amount).toBeNull()
    expect(res.value.paidOn).toBe("2026-09-10")
    expect(res.value.allocations).toEqual([
      { invoiceId: "101", amount: "800.00" },
      { invoiceId: "102", amount: "400.00" },
    ])
  })

  it("método fuera del enum de Alegra ⇒ 400", () => {
    expect(parseLoadBody(bodyValido({ method: "paypal" }), NOW)).toMatchObject({ ok: false })
    expect(parseLoadBody(bodyValido({ method: "Transfer" }), NOW)).toMatchObject({ ok: false })
  })

  it("métodos con cuenta obligatoria (transfer/deposit/check) sin bankAccountId ⇒ 400", () => {
    for (const method of ["transfer", "deposit", "check"]) {
      const res = parseLoadBody(bodyValido({ method, bankAccountId: undefined }), NOW)
      expect(res.ok).toBe(false)
    }
  })

  it("métodos sin cuenta obligatoria aceptan bankAccountId ausente", () => {
    const res = parseLoadBody(bodyValido({ method: "cash", bankAccountId: undefined }), NOW)
    expect(res.ok).toBe(true)
  })

  it("bankAccountId no numérico ⇒ 400", () => {
    expect(parseLoadBody(bodyValido({ bankAccountId: "abc" }), NOW)).toMatchObject({ ok: false })
  })

  it("allocations vacío o ausente ⇒ 400", () => {
    expect(parseLoadBody(bodyValido({ allocations: [] }), NOW)).toMatchObject({ ok: false })
    expect(parseLoadBody(bodyValido({ allocations: undefined }), NOW)).toMatchObject({ ok: false })
  })

  it("ids de factura repetidos ⇒ 400", () => {
    const res = parseLoadBody(
      bodyValido({
        allocations: [
          { invoiceId: "101", amount: "100.00" },
          { invoiceId: "101", amount: "200.00" },
        ],
      }),
      NOW,
    )
    expect(res.ok).toBe(false)
  })

  it("montos no parseables (0, negativo, 3 decimales, letra) ⇒ 400", () => {
    for (const amount of ["0", "-5", "10.555", "abc", ""]) {
      const res = parseLoadBody(bodyValido({ allocations: [{ invoiceId: "101", amount }] }), NOW)
      expect(res.ok).toBe(false)
    }
  })

  it("amount del body inválido ⇒ 400; válido se normaliza a 2 decimales", () => {
    expect(parseLoadBody(bodyValido({ amount: "mucho" }), NOW)).toMatchObject({ ok: false })
    const res = parseLoadBody(bodyValido({ amount: "1200.5" }), NOW)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) expect(res.value.amount).toBe("1200.50")
  })

  it("amount/paidOn ausentes ⇒ null (la ruta usa los de la fila)", () => {
    const res = parseLoadBody(bodyValido(), NOW)
    expect(res.ok && res.value.amount === null && res.value.paidOn === "2026-09-10").toBe(true)
    const sinFecha = parseLoadBody(bodyValido({ paidOn: undefined }), NOW)
    expect(sinFecha.ok && sinFecha.value.paidOn === null).toBe(true)
  })

  it("paidOn futura o con formato inválido ⇒ 400", () => {
    expect(parseLoadBody(bodyValido({ paidOn: "2099-01-01" }), NOW)).toMatchObject({ ok: false })
    expect(parseLoadBody(bodyValido({ paidOn: "13/09/2026" }), NOW)).toMatchObject({ ok: false })
  })

  it("body que no es objeto ⇒ 400", () => {
    expect(parseLoadBody(null, NOW)).toMatchObject({ ok: false })
    expect(parseLoadBody("transfer", NOW)).toMatchObject({ ok: false })
  })
})

describe("validateAllocations", () => {
  const allocs = (lista: [string, string][]) => lista.map(([invoiceId, amount]) => ({ invoiceId, amount }))

  it("suma exacta al monto y dentro de saldos ⇒ ok", () => {
    expect(validateAllocations(allocs([["101", "800.00"], ["102", "400.00"]]), FACTURAS, "1200.00")).toEqual({ ok: true })
  })

  it("suma menor al monto ⇒ error (pago quedaría sin imputar completo)", () => {
    const res = validateAllocations(allocs([["101", "800.00"]]), FACTURAS, "1200.00")
    expect(res.ok).toBe(false)
  })

  it("suma mayor al monto ⇒ error", () => {
    const res = validateAllocations(allocs([["101", "800.00"], ["102", "500.00"]]), FACTURAS, "1200.00")
    expect(res.ok).toBe(false)
  })

  it("una allocation supera el saldo de su factura ⇒ error con el número", () => {
    const res = validateAllocations(allocs([["101", "900.00"], ["102", "300.00"]]), FACTURAS, "1200.00")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("FV-1-0001")
  })

  it("allocation contra una factura que no está abierta (otra de Alegra o ajena) ⇒ error", () => {
    const res = validateAllocations(allocs([["999", "1200.00"]]), FACTURAS, "1200.00")
    expect(res.ok).toBe(false)
  })

  it("compara en centavos: 1200.50 + nada === 1200.50 pasa; decimales de float no rompen", () => {
    expect(validateAllocations(allocs([["102", "1200.50"]]), FACTURAS, "1200.50")).toEqual({ ok: true })
    expect(validateAllocations(allocs([["101", "400.10"], ["102", "800.40"]]), FACTURAS, "1200.50")).toEqual({ ok: true })
  })
})
