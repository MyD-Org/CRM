import { describe, it, expect } from "vitest"
import { armarContratoCuotasV2 } from "@/lib/cuotas"
import { validarJsonSchema } from "../../test/contracts/json-schema-lite"
import schema from "../../test/contracts/cuotas/v2/schema.json"
import valido from "../../test/contracts/cuotas/v2/fixtures/valido.json"
import vacioValido from "../../test/contracts/cuotas/v2/fixtures/vacio-valido.json"
import sinEscalonesValido from "../../test/contracts/cuotas/v2/fixtures/sin-escalones-valido.json"
import invalido from "../../test/contracts/cuotas/v2/fixtures/invalido.json"
import invalidoEscalones from "../../test/contracts/cuotas/v2/fixtures/invalido-escalones.json"

// El payload que arma el CRM tiene que validar contra el contrato publicado
// (copia de MyD-Org/platform/contracts/cuotas/v2 en test/contracts/; actualizar ambos juntos).

describe("contrato cuotas v2: fixtures", () => {
  it("válido, vacío válido y proveedor sin escalones pasan", () => {
    expect(validarJsonSchema(schema, valido)).toEqual([])
    expect(validarJsonSchema(schema, vacioValido)).toEqual([])
    expect(validarJsonSchema(schema, sinEscalonesValido)).toEqual([])
  })

  it("inválido se rechaza por cada motivo documentado", () => {
    const errores = validarJsonSchema(schema, invalido).join("\n")
    expect(errores).toMatch(/\$\.version: se esperaba "v2"/)
    expect(errores).toMatch(/\$\.actualizadoEn: requerido/)
    expect(errores).toMatch(/proveedores\[0\]\.codigo: propiedad no permitida/)
  })

  it("escalones inválidos se rechazan por cada motivo documentado", () => {
    const errores = validarJsonSchema(schema, invalidoEscalones).join("\n")
    expect(errores).toMatch(/escalones\[0\]\.cuotasMax: < minimum/)
    expect(errores).toMatch(/escalones\[1\]\.cuotasMax: > maximum/)
    expect(errores).toMatch(/escalones\[2\]\.montoMinimo: < minimum/)
    expect(errores).toMatch(/escalones\[3\]\.cuotasMax: tipo string/)
    expect(errores).toMatch(/escalones\[3\]\.montoMinimo: tipo string/)
    expect(errores).toMatch(/escalones\[4\]\.sinInteres: propiedad no permitida/)
  })
})

describe("contrato cuotas v2: armarContratoCuotasV2 valida", () => {
  const t = new Date("2026-09-17T18:00:00.000Z")

  it("con proveedores y escalones (centavos, inactivos filtrados)", () => {
    const c = armarContratoCuotasV2({
      tenant: "central-led",
      ahora: t,
      configActualizadaEn: t,
      proveedores: [
        { id: "p1", proveedor: "mercadopago", nombre: "Mercado Pago", activo: true, orden: 0, updatedAt: t },
        { id: "p2", proveedor: "mercadopago", nombre: "Mercado Pago", activo: false, orden: 1, updatedAt: t },
      ],
      escalones: [
        { id: "e1", proveedorId: "p1", cuotasMax: 1, montoMinimo: "0.00", activo: true, updatedAt: t },
        { id: "e2", proveedorId: "p1", cuotasMax: 24, montoMinimo: "180000.50", activo: true, updatedAt: t },
        { id: "e3", proveedorId: "p2", cuotasMax: 6, montoMinimo: "0.00", activo: true, updatedAt: t },
      ],
    })
    expect(validarJsonSchema(schema, c)).toEqual([])
    expect(c.proveedores).toHaveLength(1)
    expect(c.proveedores[0]?.escalones).toHaveLength(2)
  })

  it("vacío", () => {
    expect(
      validarJsonSchema(schema, armarContratoCuotasV2({ tenant: "t", proveedores: [], escalones: [], configActualizadaEn: null, ahora: t })),
    ).toEqual([])
  })
})
