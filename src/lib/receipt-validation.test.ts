import { describe, it, expect, vi } from "vitest"
import {
  parseInitBody,
  parseAmount,
  isValidPaidOn,
  parseReceiptsEmail,
  MAX_FILE_BYTES,
  RECEIPTS_DAILY_LIMIT,
  RECEIPTS_HOURLY_LIMIT,
  UPLOAD_URL_TTL_SECONDS,
  GET_URL_TTL_SECONDS,
} from "@/lib/receipt-validation"

const NOW = new Date("2026-09-12T15:00:00.000Z") // 12:00 en Argentina (UTC-3)

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    amount: "150000.50",
    paidOn: "2026-09-11",
    method: "transferencia",
    notes: "pago del mes",
    file: { name: "comprobante.pdf", size: 2_000_000, contentType: "application/pdf" },
    ...overrides,
  }
}

describe("constantes", () => {
  it("valores del design", () => {
    expect(MAX_FILE_BYTES).toBe(20971520)
    expect(RECEIPTS_DAILY_LIMIT).toBe(20)
    expect(RECEIPTS_HOURLY_LIMIT).toBe(10)
    expect(UPLOAD_URL_TTL_SECONDS).toBe(600)
    expect(GET_URL_TTL_SECONDS).toBe(300)
  })
})

describe("parseAmount", () => {
  it("acepta string y número, normaliza a 2 decimales", () => {
    expect(parseAmount("150000.50")).toBe("150000.50")
    expect(parseAmount("150000.5")).toBe("150000.50")
    expect(parseAmount("150000")).toBe("150000")
    expect(parseAmount(123.45)).toBe("123.45")
  })

  it("rechaza 0, negativo y no numérico", () => {
    expect(parseAmount("0")).toBeNull()
    expect(parseAmount("0.00")).toBeNull()
    expect(parseAmount("-5")).toBeNull()
    expect(parseAmount("-0.01")).toBeNull()
    expect(parseAmount("abc")).toBeNull()
    expect(parseAmount("")).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(NaN)).toBeNull()
    expect(parseAmount(Infinity)).toBeNull()
  })

  it("rechaza 3 decimales y >12 dígitos enteros", () => {
    expect(parseAmount("12.345")).toBeNull()
    expect(parseAmount("0.001")).toBeNull()
    expect(parseAmount("9999999999999.99")).toBeNull() // 13 dígitos enteros
    expect(parseAmount("999999999999.99")).toBe("999999999999.99")
    expect(parseAmount("999999999999.999")).toBeNull()
    expect(parseAmount("1.000.000,50")).toBeNull() // formato local no va al API
  })
})

describe("isValidPaidOn", () => {
  it("acepta hoy y fechas pasadas dentro de 2 años", () => {
    expect(isValidPaidOn("2026-09-12", NOW)).toBe(true) // hoy
    expect(isValidPaidOn("2026-09-11", NOW)).toBe(true)
    expect(isValidPaidOn("2024-09-12", NOW)).toBe(true) // exactamente 2 años
  })

  it("rechaza fecha futura en el borde de medianoche argentino", () => {
    vi.useFakeTimers()
    try {
      // 02:30 UTC del 12/9 = 23:30 del 11/9 en Argentina. "2026-09-12" todavía es futuro.
      vi.setSystemTime(new Date("2026-09-12T02:30:00.000Z"))
      expect(isValidPaidOn("2026-09-12", new Date())).toBe(false)
      expect(isValidPaidOn("2026-09-11", new Date())).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rechaza futuro, >2 años y calendario inválido", () => {
    expect(isValidPaidOn("2026-09-13", NOW)).toBe(false)
    expect(isValidPaidOn("2024-09-11", NOW)).toBe(false)
    expect(isValidPaidOn("2026-02-30", NOW)).toBe(false)
    expect(isValidPaidOn("12/09/2026", NOW)).toBe(false)
    expect(isValidPaidOn("2026-9-1", NOW)).toBe(false)
    expect(isValidPaidOn(null, NOW)).toBe(false)
  })
})

describe("parseInitBody", () => {
  it("happy path: parsea y normaliza", () => {
    const r = parseInitBody(validBody({ method: "otro", methodOther: "  depósito en ventanilla  " }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.amount).toBe("150000.50")
      expect(r.value.paidOn).toBe("2026-09-11")
      expect(r.value.method).toBe("otro")
      expect(r.value.methodOther).toBe("depósito en ventanilla")
      expect(r.value.notes).toBe("pago del mes")
      expect(r.value.file).toEqual({ name: "comprobante.pdf", size: 2_000_000, contentType: "application/pdf" })
    }
  })

  it("rechaza con fields por campo", () => {
    const r = parseInitBody(validBody({ amount: "0", paidOn: "2026-09-13", method: "bitcoin", notes: "x".repeat(501) }), NOW)
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (!r.ok && r.status === 400) {
      expect(r.fields.amount).toBeTruthy()
      expect(r.fields.paidOn).toBeTruthy()
      expect(r.fields.method).toBeTruthy()
      expect(r.fields.notes).toBeTruthy()
    }
  })

  it("otro sin detalle ⇒ field methodOther; con detalle ok; detalle se ignora si no es otro", () => {
    const sinDetalle = parseInitBody(validBody({ method: "otro", methodOther: "" }), NOW)
    expect(sinDetalle).toMatchObject({ ok: false, status: 400 })
    if (!sinDetalle.ok && sinDetalle.status === 400) expect(sinDetalle.fields.methodOther).toBeTruthy()

    const ignorado = parseInitBody(validBody({ method: "transferencia", methodOther: "esto se ignora" }), NOW)
    expect(ignorado.ok).toBe(true)
    if (ignorado.ok) expect(ignorado.value.methodOther).toBeNull()

    const detalleLargo = parseInitBody(validBody({ method: "otro", methodOther: "x".repeat(81) }), NOW)
    expect(detalleLargo.ok).toBe(false)
  })

  it("notas 501 ⇒ 400; notas vacías ⇒ null; sin notas ⇒ null", () => {
    expect(parseInitBody(validBody({ notes: "x".repeat(501) }), NOW).ok).toBe(false)
    const vacias = parseInitBody(validBody({ notes: "   " }), NOW)
    expect(vacias.ok).toBe(true)
    if (vacias.ok) expect(vacias.value.notes).toBeNull()
    const sinNotas = parseInitBody(validBody({ notes: undefined }), NOW)
    expect(sinNotas.ok).toBe(true)
    if (sinNotas.ok) expect(sinNotas.value.notes).toBeNull()
  })

  it("size 0 ⇒ 413, 20 MiB ok, 20 MiB + 1 ⇒ 413", () => {
    expect(parseInitBody(validBody({ file: { name: "a.pdf", size: 0, contentType: "application/pdf" } }), NOW)).toMatchObject({
      ok: false,
      status: 413,
      code: "file_too_large",
    })
    expect(
      parseInitBody(validBody({ file: { name: "a.pdf", size: MAX_FILE_BYTES, contentType: "application/pdf" } }), NOW).ok,
    ).toBe(true)
    expect(
      parseInitBody(validBody({ file: { name: "a.pdf", size: MAX_FILE_BYTES + 1, contentType: "application/pdf" } }), NOW),
    ).toMatchObject({ ok: false, status: 413, code: "file_too_large" })
  })

  it("tipo declarado svg ⇒ 415 unsupported_type; heic/heif entran (C los convierte en el confirm)", () => {
    const svg = parseInitBody(validBody({ file: { name: "a.svg", size: 10, contentType: "image/svg+xml" } }), NOW)
    expect(svg).toMatchObject({ ok: false, status: 415, code: "unsupported_type" })
    expect(parseInitBody(validBody({ file: { name: "a.heic", size: 10, contentType: "image/heic" } }), NOW).ok).toBe(true)
    expect(parseInitBody(validBody({ file: { name: "a.heif", size: 10, contentType: "image/heif" } }), NOW).ok).toBe(true)
  })

  it("acepta los tipos declarados permitidos", () => {
    for (const contentType of ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(parseInitBody(validBody({ file: { name: "a", size: 10, contentType } }), NOW).ok).toBe(true)
    }
  })

  it("body sin file o file incompleto ⇒ 400", () => {
    expect(parseInitBody(validBody({ file: undefined }), NOW).ok).toBe(false)
    expect(parseInitBody(validBody({ file: { name: "a.pdf", size: 10 } }), NOW).ok).toBe(false)
    expect(parseInitBody(null, NOW).ok).toBe(false)
  })
})

describe("parseReceiptsEmail", () => {
  it("acepta un email y normaliza el dominio a minúsculas", () => {
    expect(parseReceiptsEmail("Pagos@Ejemplo.COM")).toBe("Pagos@ejemplo.com")
    expect(parseReceiptsEmail("  pagos@ejemplo.com  ")).toBe("pagos@ejemplo.com")
  })

  it("vacío ⇒ ''", () => {
    expect(parseReceiptsEmail("")).toBe("")
    expect(parseReceiptsEmail("   ")).toBe("")
  })

  it("rechaza coma, ';', CRLF (inyección de headers/destinatarios) y otros inválidos", () => {
    expect(parseReceiptsEmail("a@ejemplo.com,b@ejemplo.com")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo.com;b@ejemplo.com")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo.com\r\nBcc: otro@ejemplo.com")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo.com\nBcc: x")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo.com otro@ejemplo.com")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo.com,")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo")).toBeNull()
    expect(parseReceiptsEmail("@ejemplo.com")).toBeNull()
    expect(parseReceiptsEmail("a b@ejemplo.com")).toBeNull()
    expect(parseReceiptsEmail("a@ejemplo.com " + "x".repeat(250))).toBeNull()
    expect(parseReceiptsEmail(null)).toBeNull()
    expect(parseReceiptsEmail(123)).toBeNull()
  })
})
