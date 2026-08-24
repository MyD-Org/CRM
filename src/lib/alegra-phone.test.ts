import { describe, it, expect } from "vitest"
import { normalizePhone, searchContactsByPhone } from "./alegra"
import type { TenantConfig } from "./tenants"

// Tenant en modo mock: searchContactsByPhone filtra sobre mockContacts sin pegarle a Alegra.
const tenantMock = { id: "t", alegraMock: true } as unknown as TenantConfig

describe("normalizePhone", () => {
  it("empareja los formatos en que llega el mismo número", () => {
    // wa_id (sin '+'), Alegra, y carga a mano con 0 y con espacios.
    const wa = normalizePhone("5492235903012")
    expect(normalizePhone("+5492235903012")).toBe(wa)
    expect(normalizePhone("+54 9 223 590-3012")).toBe(wa)
    expect(normalizePhone("02235903012")).toBe(wa)
    expect(normalizePhone("223 590 3012")).toBe(wa)
  })

  it("no confunde números distintos", () => {
    expect(normalizePhone("+5492235903012")).not.toBe(normalizePhone("+5492235903025"))
  })

  it("normaliza los formatos que ya están cargados en esta cuenta de Alegra", () => {
    expect(normalizePhone(" 011 4574-3077")).toBe("1145743077")
    expect(normalizePhone("223 4959686")).toBe("2234959686")
    expect(normalizePhone("+54 (11) 4707-0184 ")).toBe("1147070184")
  })

  it("trata como ausente lo que no identifica una línea", () => {
    expect(normalizePhone("")).toBe("")
    expect(normalizePhone(null)).toBe("")
    expect(normalizePhone(undefined)).toBe("")
    expect(normalizePhone("1234567")).toBe("") // 7 dígitos: matchearía de más
    expect(normalizePhone("no tengo")).toBe("")
  })
})

describe("searchContactsByPhone", () => {
  it("encuentra el contacto aunque el formato guardado sea distinto al buscado", async () => {
    // En los mocks está como "+54 223 495-8877"; el bot manda el wa_id sin '+' ni guiones.
    const found = await searchContactsByPhone(tenantMock, "542234958877")
    expect(found.map((c) => c.name)).toEqual(["Ferretería El Tornillo"])
  })

  it("no devuelve nada para un número que no está cargado", async () => {
    expect(await searchContactsByPhone(tenantMock, "5492235903012")).toEqual([])
  })

  it("no devuelve nada si el teléfono buscado no identifica una línea", async () => {
    // Sin esta guarda, un teléfono vacío matchearía contra los contactos sin teléfono.
    expect(await searchContactsByPhone(tenantMock, "")).toEqual([])
    expect(await searchContactsByPhone(tenantMock, "123")).toEqual([])
  })
})

describe("cuentas internas", () => {
  it("no resuelve una cuenta interna como cliente aunque comparta el teléfono", async () => {
    // "Stock general" tiene cargado el mismo número que Constructora Delta. Sin el filtro,
    // el bot le colgaría el pedido a la cuenta interna la mitad de las veces.
    const found = await searchContactsByPhone(tenantMock, "541147889900")
    expect(found.map((c) => c.name)).toEqual(["Constructora Delta SA"])
  })
})
