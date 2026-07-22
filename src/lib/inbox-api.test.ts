import { describe, it, expect } from "vitest"
import { channelLabel } from "./inbox-api"

describe("channelLabel", () => {
  it("mapea los canales conocidos a su nombre legible", () => {
    expect(channelLabel("whatsapp")).toBe("WhatsApp")
    expect(channelLabel("instagram")).toBe("Instagram")
    expect(channelLabel("messenger")).toBe("Messenger")
  })

  it("devuelve el valor crudo si el canal no se reconoce", () => {
    expect(channelLabel("telegram")).toBe("telegram")
  })

  it("usa un fallback para null/undefined/vacío", () => {
    expect(channelLabel(null)).toBe("Canal desconocido")
    expect(channelLabel(undefined)).toBe("Canal desconocido")
    expect(channelLabel("")).toBe("Canal desconocido")
  })
})
