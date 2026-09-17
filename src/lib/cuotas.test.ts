import { describe, it, expect } from "vitest"
import {
  armarContratoCuotasV2,
  buscarMontoRepetido,
  nombreProveedor,
  PROVEEDORES,
  validarEscalon,
  validarProveedor,
  type EscalonFila,
  type ProveedorFila,
  type Resultado,
} from "@/lib/cuotas"

const PROVEEDOR_ID = "7b1f0c7e-0000-4000-8000-000000000001"

function escalonBody(overrides: Record<string, unknown> = {}) {
  return { proveedorId: PROVEEDOR_ID, cuotasMax: 6, montoMinimo: "180000", ...overrides }
}

function campoDe(r: Resultado<unknown>): string | undefined {
  return r.ok ? undefined : r.campo
}

describe("proveedores disponibles", () => {
  it("hoy sólo Mercado Pago", () => {
    expect(PROVEEDORES).toEqual([{ id: "mercadopago", nombre: "Mercado Pago" }])
    expect(nombreProveedor("mercadopago")).toBe("Mercado Pago")
    expect(nombreProveedor("visa")).toBeNull()
  })
})

describe("validarProveedor", () => {
  it("alta: proveedor de la lista, nombre derivado, defaults activo/orden", () => {
    expect(validarProveedor({ proveedor: "mercadopago" })).toEqual({
      ok: true,
      value: { proveedor: "mercadopago", nombre: "Mercado Pago", activo: true, orden: 0 },
    })
  })

  it.each([undefined, "", "visa", "MercadoPago", 3])("proveedor %s → error", (proveedor) => {
    const r = validarProveedor({ proveedor })
    expect(campoDe(r)).toBe("proveedor")
  })

  it("ignora nombre y código del body (no se tipean)", () => {
    const r = validarProveedor({ proveedor: "mercadopago", nombre: "Otro", codigoProveedor: "visa" })
    expect(r).toMatchObject({ ok: true, value: { nombre: "Mercado Pago" } })
    expect(r.ok && "codigoProveedor" in r.value).toBe(false)
  })

  it("PATCH parcial conserva lo actual", () => {
    const actual = { proveedor: "mercadopago", nombre: "Mercado Pago", activo: true, orden: 2 }
    expect(validarProveedor({ activo: false }, actual)).toEqual({ ok: true, value: { ...actual, activo: false } })
  })

  it.each([
    [{ activo: "si" }, "activo"],
    [{ orden: -1 }, "orden"],
    [{ orden: 1.5 }, "orden"],
    [{ orden: 10000 }, "orden"],
  ])("%j → error en %s", (extra, campo) => {
    expect(campoDe(validarProveedor({ proveedor: "mercadopago", ...extra }))).toBe(campo)
  })

  it("body no objeto → error", () => {
    expect(campoDe(validarProveedor(null))).toBe("body")
    expect(campoDe(validarProveedor([]))).toBe("body")
  })
})

describe("validarEscalon: cuotasMax", () => {
  it.each([0, 25, 2.5, "abc", null, undefined, -3, "1.5"])("cuotasMax %s → error", (cuotasMax) => {
    expect(campoDe(validarEscalon(escalonBody({ cuotasMax })))).toBe("cuotasMax")
  })

  it.each([1, 24, "12"])("cuotasMax %s → ok", (cuotasMax) => {
    const r = validarEscalon(escalonBody({ cuotasMax }))
    expect(r.ok && r.value.cuotasMax).toBe(Number(cuotasMax))
  })
})

describe("validarEscalon: monto mínimo", () => {
  it.each(["", null, undefined])("vacío (%s) → 0", (montoMinimo) => {
    const r = validarEscalon(escalonBody({ montoMinimo }))
    expect(r.ok && r.value.montoMinimo).toBe("0.00")
  })

  it("normaliza a 2 decimales (string o número)", () => {
    expect(validarEscalon(escalonBody({ montoMinimo: "180000.5" }))).toMatchObject({ ok: true, value: { montoMinimo: "180000.50" } })
    expect(validarEscalon(escalonBody({ montoMinimo: 50000.25 }))).toMatchObject({ ok: true, value: { montoMinimo: "50000.25" } })
    expect(validarEscalon(escalonBody({ montoMinimo: 0 }))).toMatchObject({ ok: true, value: { montoMinimo: "0.00" } })
  })

  it.each([-1, "-0.01", "abc", "1,5", "1.234", Number.NaN, Number.POSITIVE_INFINITY, "1000000000000"])(
    "inválido (%s) → error",
    (montoMinimo) => {
      expect(campoDe(validarEscalon(escalonBody({ montoMinimo })))).toBe("montoMinimo")
    },
  )
})

describe("validarEscalon: resto", () => {
  it("defaults y shape (sin sinInteres ni vigencias)", () => {
    expect(validarEscalon(escalonBody())).toEqual({
      ok: true,
      value: { proveedorId: PROVEEDOR_ID, cuotasMax: 6, montoMinimo: "180000.00", activo: true },
    })
  })

  it("falta el proveedor → error", () => {
    expect(campoDe(validarEscalon(escalonBody({ proveedorId: "" })))).toBe("proveedorId")
    expect(campoDe(validarEscalon({ cuotasMax: 3 }))).toBe("proveedorId")
  })

  it("activo no booleano → error", () => {
    expect(campoDe(validarEscalon(escalonBody({ activo: 1 })))).toBe("activo")
  })

  it("body no objeto → error", () => {
    expect(campoDe(validarEscalon("x"))).toBe("body")
  })

  it("PATCH parcial conserva lo actual", () => {
    const actual = { proveedorId: PROVEEDOR_ID, cuotasMax: 3, montoMinimo: "0.00", activo: true }
    expect(validarEscalon({ cuotasMax: 12 }, actual)).toEqual({ ok: true, value: { ...actual, cuotasMax: 12 } })
  })
})

describe("buscarMontoRepetido", () => {
  const existentes = [
    { id: "a", montoMinimo: "0.00", activo: true },
    { id: "b", montoMinimo: "180000.00", activo: true },
    { id: "c", montoMinimo: "500000.00", activo: false },
  ]

  it("activo con el mismo monto que otro activo → choca", () => {
    expect(buscarMontoRepetido({ montoMinimo: "180000.00", activo: true }, existentes)?.id).toBe("b")
  })

  it("mismo monto que uno inactivo → no choca", () => {
    expect(buscarMontoRepetido({ montoMinimo: "500000.00", activo: true }, existentes)).toBeNull()
  })

  it("candidato inactivo nunca choca", () => {
    expect(buscarMontoRepetido({ montoMinimo: "0.00", activo: false }, existentes)).toBeNull()
  })

  it("editándose a sí mismo no choca", () => {
    expect(buscarMontoRepetido({ id: "b", montoMinimo: "180000.00", activo: true }, existentes)).toBeNull()
  })

  it("compara montos numéricamente (\"180000\" = \"180000.00\")", () => {
    expect(buscarMontoRepetido({ montoMinimo: "180000", activo: true }, existentes)?.id).toBe("b")
  })
})

describe("armarContratoCuotasV2", () => {
  const t0 = new Date("2026-09-17T10:00:00.000Z")
  const t1 = new Date("2026-09-17T11:00:00.000Z")
  const t2 = new Date("2026-09-17T12:00:00.000Z")
  const ahora = new Date("2026-09-17T18:00:00.000Z")

  const mp: ProveedorFila = { id: "p1", proveedor: "mercadopago", nombre: "Mercado Pago", activo: true, orden: 0, updatedAt: t0 }
  const esc = (o: Partial<EscalonFila> & { id: string }): EscalonFila => ({
    proveedorId: "p1",
    cuotasMax: 3,
    montoMinimo: "0.00",
    activo: true,
    updatedAt: t0,
    ...o,
  })

  it("sólo activos, escalones por monto asc, montoMinimo numérico", () => {
    const c = armarContratoCuotasV2({
      tenant: "central-led",
      ahora,
      configActualizadaEn: null,
      proveedores: [mp, { ...mp, id: "p2", proveedor: "otro", nombre: "Otro", activo: false, orden: 1 }],
      escalones: [
        esc({ id: "e3", cuotasMax: 12, montoMinimo: "500000.50" }),
        esc({ id: "e1", cuotasMax: 3, montoMinimo: "0.00" }),
        esc({ id: "e2", cuotasMax: 6, montoMinimo: "180000.00", updatedAt: t1 }),
        esc({ id: "e4", cuotasMax: 18, montoMinimo: "900000.00", activo: false }),
        esc({ id: "e5", proveedorId: "p2", cuotasMax: 24 }),
      ],
    })
    expect(c).toEqual({
      version: "v2",
      tenant: "central-led",
      actualizadoEn: t1.toISOString(),
      proveedores: [
        {
          id: "p1",
          proveedor: "mercadopago",
          nombre: "Mercado Pago",
          activo: true,
          orden: 0,
          escalones: [
            { id: "e1", cuotasMax: 3, montoMinimo: 0 },
            { id: "e2", cuotasMax: 6, montoMinimo: 180000 },
            { id: "e3", cuotasMax: 12, montoMinimo: 500000.5 },
          ],
        },
      ],
    })
  })

  it("proveedores por orden", () => {
    const c = armarContratoCuotasV2({
      tenant: "t",
      ahora,
      configActualizadaEn: null,
      proveedores: [{ ...mp, id: "b", orden: 2 }, { ...mp, id: "a", orden: 1 }],
      escalones: [],
    })
    expect(c.proveedores.map((p) => p.id)).toEqual(["a", "b"])
    expect(c.proveedores[0]?.escalones).toEqual([])
  })

  it("actualizadoEn considera inactivos y la versión de config (borrados)", () => {
    const base = { tenant: "t", ahora, proveedores: [mp], escalones: [esc({ id: "x", activo: false, updatedAt: t1 })] }
    expect(armarContratoCuotasV2({ ...base, configActualizadaEn: null }).actualizadoEn).toBe(t1.toISOString())
    expect(armarContratoCuotasV2({ ...base, configActualizadaEn: t2 }).actualizadoEn).toBe(t2.toISOString())
  })

  it("sin filas ni versión → ahora", () => {
    const c = armarContratoCuotasV2({ tenant: "t", ahora, configActualizadaEn: null, proveedores: [], escalones: [] })
    expect(c).toEqual({ version: "v2", tenant: "t", actualizadoEn: ahora.toISOString(), proveedores: [] })
  })
})
