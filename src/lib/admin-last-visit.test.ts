// Tests unitarios del helper de last-visit de secciones (src/lib/admin-last-visit.ts).
// El entorno de test es node (sin window): se stubbea window con un localStorage en memoria
// y un mini bus de eventos para verificar que markVisited notifica a los listeners.

import { describe, it, expect, vi, afterEach } from "vitest"
import { getLastVisit, markVisited, SECTION_VISITED_EVENT } from "@/lib/admin-last-visit"

const store = new Map<string, string>()
const listeners = new Set<(e: Event) => void>()

vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
  dispatchEvent: (e: Event) => {
    for (const f of listeners) f(e)
    return true
  },
  addEventListener: (_: string, f: (e: Event) => void) => void listeners.add(f),
  removeEventListener: (_: string, f: (e: Event) => void) => void listeners.delete(f),
})

describe("admin-last-visit", () => {
  afterEach(() => {
    store.clear()
    listeners.clear()
    vi.restoreAllMocks()
  })

  it("sin marca previa devuelve null (sin filtro: backlog)", () => {
    expect(getLastVisit("inbox")).toBeNull()
    expect(getLastVisit("comprobantes")).toBeNull()
  })

  it("markVisited persiste un ISO parseable y dispara el evento con la sección", () => {
    const visto = vi.fn()
    window.addEventListener(SECTION_VISITED_EVENT, visto)

    markVisited("inbox")

    const guardado = getLastVisit("inbox")
    expect(guardado).not.toBeNull()
    expect(Number.isNaN(Date.parse(guardado as string))).toBe(false)
    expect(getLastVisit("comprobantes")).toBeNull() // la otra sección no se tocó
    expect(visto).toHaveBeenCalledTimes(1)
    expect((visto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "inbox" })
  })

  it("marcar de nuevo pisa el valor anterior", () => {
    markVisited("comprobantes")
    const primero = getLastVisit("comprobantes")
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000))
      markVisited("comprobantes")
    } finally {
      vi.useRealTimers()
    }
    expect(getLastVisit("comprobantes")).not.toBe(primero)
  })
})
