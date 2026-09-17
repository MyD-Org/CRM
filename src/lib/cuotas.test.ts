import { describe, it, expect } from "vitest"
import {
  validarMedio,
  validarOpcion,
  seSuperponen,
  buscarSuperpuesta,
  armarContratoCuotasV1,
  type OpcionValida,
  type Resultado,
} from "@/lib/cuotas"

const MEDIO_ID = "7b1f0c7e-0000-4000-8000-000000000001"

function opcionBody(overrides: Record<string, unknown> = {}) {
  return { paymentMethodId: MEDIO_ID, cuotas: 6, sinInteres: true, montoMinimo: "150000", ...overrides }
}

function errorDe(r: Resultado<unknown>): string | undefined {
  return r.ok ? undefined : r.campo
}

describe("validarOpcion: cuotas", () => {
  it.each([1, 30, 2.5, "abc", null, undefined, 0, -3])("cuotas %s → error", (cuotas) => {
    const r = validarOpcion(opcionBody({ cuotas }))
    expect(r.ok).toBe(false)
    expect(errorDe(r)).toBe("cuotas")
  })

  it.each([2, 24, "12"])("cuotas %s → ok", (cuotas) => {
    const r = validarOpcion(opcionBody({ cuotas }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.cuotas).toBe(Number(cuotas))
  })
})

describe("validarOpcion: monto mínimo", () => {
  it.each(["", null, undefined])("vacío (%s) → 0", (montoMinimo) => {
    const r = validarOpcion(opcionBody({ montoMinimo }))
    expect(r.ok && r.value.montoMinimo).toBe("0.00")
  })

  it("normaliza a 2 decimales (string o número)", () => {
    expect(validarOpcion(opcionBody({ montoMinimo: "150000.5" }))).toMatchObject({ ok: true, value: { montoMinimo: "150000.50" } })
    expect(validarOpcion(opcionBody({ montoMinimo: 50000.25 }))).toMatchObject({ ok: true, value: { montoMinimo: "50000.25" } })
  })

  it.each([-1, "-0.01", "abc", "1,5", "1.234", Number.NaN])("inválido (%s) → error", (montoMinimo) => {
    const r = validarOpcion(opcionBody({ montoMinimo }))
    expect(r.ok).toBe(false)
    expect(errorDe(r)).toBe("montoMinimo")
  })
})

describe("validarOpcion: vigencia", () => {
  it("desde > hasta → error", () => {
    const r = validarOpcion(opcionBody({ vigenteDesde: "2026-10-31", vigenteHasta: "2026-10-01" }))
    expect(r.ok).toBe(false)
    expect(errorDe(r)).toBe("vigenteHasta")
  })

  it("desde = hasta → ok (inclusive)", () => {
    expect(validarOpcion(opcionBody({ vigenteDesde: "2026-10-01", vigenteHasta: "2026-10-01" })).ok).toBe(true)
  })

  it("vacío → null de ese lado", () => {
    const r = validarOpcion(opcionBody({ vigenteDesde: "", vigenteHasta: null }))
    expect(r).toMatchObject({ ok: true, value: { vigenteDesde: null, vigenteHasta: null } })
  })

  it.each(["30/09/2026", "2026-02-30", "2026-9-1", 20260901])("fecha mal formada (%s) → error", (vigenteDesde) => {
    const r = validarOpcion(opcionBody({ vigenteDesde }))
    expect(r.ok).toBe(false)
    expect(errorDe(r)).toBe("vigenteDesde")
  })
})

describe("validarOpcion: resto", () => {
  it("defaults: sinInteres false, activo true", () => {
    const r = validarOpcion({ paymentMethodId: MEDIO_ID, cuotas: 3 })
    expect(r).toMatchObject({ ok: true, value: { sinInteres: false, activo: true, montoMinimo: "0.00" } })
  })

  it("falta medio → error", () => {
    expect(errorDe(validarOpcion(opcionBody({ paymentMethodId: "" })))).toBe("paymentMethodId")
  })

  it("booleans no booleanos → error", () => {
    expect(errorDe(validarOpcion(opcionBody({ sinInteres: "si" })))).toBe("sinInteres")
    expect(errorDe(validarOpcion(opcionBody({ activo: 1 })))).toBe("activo")
  })

  it("body no objeto → error", () => {
    expect(validarOpcion(null).ok).toBe(false)
  })

  it("parcial sobre la actual (PATCH): sólo pisa lo que viene", () => {
    const actual: OpcionValida = {
      paymentMethodId: MEDIO_ID,
      cuotas: 6,
      sinInteres: true,
      montoMinimo: "150000.00",
      vigenteDesde: "2026-09-01",
      vigenteHasta: null,
      activo: true,
    }
    expect(validarOpcion({ activo: false }, actual)).toEqual({ ok: true, value: { ...actual, activo: false } })
    expect(validarOpcion({ vigenteHasta: "2026-08-01" }, actual).ok).toBe(false)
  })
})

describe("validarMedio", () => {
  it("alta válida con defaults", () => {
    expect(validarMedio({ proveedor: " mercadopago ", codigoProveedor: "visa", nombre: "Visa" })).toEqual({
      ok: true,
      value: { proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", activo: true, orden: 0 },
    })
  })

  it.each([
    [{ codigoProveedor: "visa", nombre: "Visa" }, "proveedor"],
    [{ proveedor: "mercadopago", codigoProveedor: " ", nombre: "Visa" }, "codigoProveedor"],
    [{ proveedor: "mercadopago", codigoProveedor: "visa" }, "nombre"],
    [{ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", orden: 1.5 }, "orden"],
    [{ proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", activo: "true" }, "activo"],
  ])("inválido %j → %s", (body, campo) => {
    expect(errorDe(validarMedio(body))).toBe(campo)
  })

  it("parcial sobre el actual", () => {
    const actual = { proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", activo: true, orden: 0 }
    expect(validarMedio({ activo: false }, actual)).toEqual({ ok: true, value: { ...actual, activo: false } })
  })
})

describe("superposición", () => {
  it("rangos abiertos y cerrados", () => {
    expect(seSuperponen({ desde: null, hasta: null }, { desde: "2026-10-01", hasta: "2026-10-31" })).toBe(true)
    expect(seSuperponen({ desde: null, hasta: "2026-09-30" }, { desde: "2026-10-01", hasta: "2026-10-31" })).toBe(false)
    // Inclusive: compartir el mismo día es superponerse.
    expect(seSuperponen({ desde: null, hasta: "2026-10-01" }, { desde: "2026-10-01", hasta: null })).toBe(true)
  })

  const existente = { id: "a", cuotas: 6, activo: true, vigenteDesde: null, vigenteHasta: null }
  const octubre = { cuotas: 6, activo: true, vigenteDesde: "2026-10-01", vigenteHasta: "2026-10-31" }

  it("visa 6 activa sin vigencia + nueva visa 6 en octubre → rechaza", () => {
    expect(buscarSuperpuesta(octubre, [existente])).toEqual(existente)
  })

  it("con la primera hasta 30/09 → acepta", () => {
    expect(buscarSuperpuesta(octubre, [{ ...existente, vigenteHasta: "2026-09-30" }])).toBeNull()
  })

  it("inactiva no cuenta (ni la existente ni la candidata)", () => {
    expect(buscarSuperpuesta(octubre, [{ ...existente, activo: false }])).toBeNull()
    expect(buscarSuperpuesta({ ...octubre, activo: false }, [existente])).toBeNull()
  })

  it("otras cuotas no cuentan; la misma fila (edición) tampoco", () => {
    expect(buscarSuperpuesta(octubre, [{ ...existente, cuotas: 12 }])).toBeNull()
    expect(buscarSuperpuesta({ ...octubre, id: "a" }, [existente])).toBeNull()
  })
})

describe("armarContratoCuotasV1", () => {
  const t0 = new Date("2026-09-10T12:00:00.000Z")
  const t1 = new Date("2026-09-15T12:00:00.000Z")
  const ahora = new Date("2026-09-16T20:00:00.000Z")

  const medios = [
    { id: "m-master", proveedor: "mercadopago", codigoProveedor: "master", nombre: "Mastercard", activo: true, orden: 1, updatedAt: t0 },
    { id: "m-visa", proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", activo: true, orden: 0, updatedAt: t0 },
    { id: "m-amex", proveedor: "mercadopago", codigoProveedor: "amex", nombre: "Amex", activo: false, orden: 2, updatedAt: t0 },
  ]
  const base = { sinInteres: false, montoMinimo: "0.00", vigenteDesde: null, vigenteHasta: null, activo: true, updatedAt: t0 }
  const opciones = [
    { ...base, id: "o-visa-6", paymentMethodId: "m-visa", cuotas: 6, sinInteres: true, montoMinimo: "150000.00", vigenteDesde: "2026-09-01" },
    { ...base, id: "o-visa-3", paymentMethodId: "m-visa", cuotas: 3 },
    { ...base, id: "o-visa-12-off", paymentMethodId: "m-visa", cuotas: 12, activo: false, updatedAt: t1 },
    { ...base, id: "o-master-12", paymentMethodId: "m-master", cuotas: 12, montoMinimo: "50000.50" },
    { ...base, id: "o-amex-3", paymentMethodId: "m-amex", cuotas: 3 },
  ]

  it("sólo medios y opciones activos (con medio activo), vigencias como string, montos como number", () => {
    const c = armarContratoCuotasV1({ tenant: "central-led", medios, opciones, ahora })
    expect(c.version).toBe("v1")
    expect(c.tenant).toBe("central-led")
    expect(c.medios.map((m) => m.codigo)).toEqual(["visa", "master"])
    expect(c.medios[0]).toEqual({ id: "m-visa", proveedor: "mercadopago", codigo: "visa", nombre: "Visa", activo: true, orden: 0 })
    expect(c.opciones.map((o) => o.id)).toEqual(["o-visa-3", "o-visa-6", "o-master-12"])
    expect(c.opciones[1]).toEqual({
      id: "o-visa-6",
      medioId: "m-visa",
      cuotas: 6,
      sinInteres: true,
      montoMinimo: 150000,
      vigenteDesde: "2026-09-01",
      vigenteHasta: null,
      activo: true,
    })
    expect(c.opciones[2]?.montoMinimo).toBe(50000.5)
  })

  it("actualizadoEn = última modificación (incluye filas inactivas: desactivar también es un cambio)", () => {
    expect(armarContratoCuotasV1({ tenant: "t", medios, opciones, ahora }).actualizadoEn).toBe(t1.toISOString())
  })

  it("sin filas → vacío válido con actualizadoEn = ahora", () => {
    expect(armarContratoCuotasV1({ tenant: "t", medios: [], opciones: [], ahora })).toEqual({
      version: "v1",
      tenant: "t",
      actualizadoEn: ahora.toISOString(),
      medios: [],
      opciones: [],
    })
  })
})
