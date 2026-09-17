import { describe, it, expect } from "vitest"
import { armarContratoCuotasV1 } from "@/lib/cuotas"
import { validarJsonSchema } from "../../test/contracts/json-schema-lite"
import schema from "../../test/contracts/cuotas/v1/schema.json"
import valido from "../../test/contracts/cuotas/v1/fixtures/valido.json"
import vacioValido from "../../test/contracts/cuotas/v1/fixtures/vacio-valido.json"
import invalido from "../../test/contracts/cuotas/v1/fixtures/invalido.json"

// El payload que arma el CRM tiene que validar contra el contrato publicado
// (copia de MyD-Org/platform/contracts/cuotas/v1 en test/contracts/; actualizar ambos juntos).

describe("contrato cuotas v1: fixtures", () => {
  it("válido y vacío válido pasan", () => {
    expect(validarJsonSchema(schema, valido)).toEqual([])
    expect(validarJsonSchema(schema, vacioValido)).toEqual([])
  })

  it("inválido se rechaza por cada motivo documentado", () => {
    const errores = validarJsonSchema(schema, invalido).join("\n")
    expect(errores).toMatch(/\$\.version/)
    expect(errores).toMatch(/\$\.actualizadoEn: requerido/)
    expect(errores).toMatch(/cuotas: tipo string/)
    expect(errores).toMatch(/montoMinimo: < minimum/)
    expect(errores).toMatch(/vigenteDesde: oneOf/)
  })
})

describe("contrato cuotas v1: armarContratoCuotasV1 valida", () => {
  const t = new Date("2026-09-16T20:00:00.000Z")

  it("con medios y opciones (centavos, vigencias, inactivos filtrados)", () => {
    const c = armarContratoCuotasV1({
      tenant: "central-led",
      ahora: t,
      medios: [
        { id: "m1", proveedor: "mercadopago", codigoProveedor: "visa", nombre: "Visa", activo: true, orden: 0, updatedAt: t },
        { id: "m2", proveedor: "mercadopago", codigoProveedor: "amex", nombre: "Amex", activo: false, orden: 1, updatedAt: t },
      ],
      opciones: [
        { id: "o1", paymentMethodId: "m1", cuotas: 6, sinInteres: true, montoMinimo: "150000.50", vigenteDesde: "2026-09-01", vigenteHasta: "2026-09-30", activo: true, updatedAt: t },
        { id: "o2", paymentMethodId: "m2", cuotas: 3, sinInteres: false, montoMinimo: "0.00", vigenteDesde: null, vigenteHasta: null, activo: true, updatedAt: t },
      ],
    })
    expect(validarJsonSchema(schema, c)).toEqual([])
    expect(c.opciones).toHaveLength(1)
  })

  it("vacío", () => {
    expect(validarJsonSchema(schema, armarContratoCuotasV1({ tenant: "t", medios: [], opciones: [], ahora: t }))).toEqual([])
  })
})
