import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  limpiarCacheTasas,
  normalizarTasasMP,
  obtenerTasasMercadoPago,
  parsearLabelsMP,
  textoTasa,
  MONTO_REFERENCIA,
  TTL_MS,
} from "@/lib/mp-tasas"

// Nunca se llama a Mercado Pago en vivo: el fetch se inyecta.

const pc = (installments: number, rate: number, labels: string[] = []) => ({ installments, installment_rate: rate, labels })

const visa = [
  { payment_method_id: "visa", issuer: { id: "1" }, payer_costs: [pc(1, 0), pc(3, 0, ["CFT_0,00%|TEA_0,00%"]), pc(6, 20, ["CFT_40,10%|TEA_30,00%"])] },
  { payment_method_id: "visa", issuer: { id: "2" }, payer_costs: [pc(3, 5.5, ["CFT_12,34%|TEA_10,00%"]), pc(6, 32.14, ["CFT_1.045,67%|TEA_80,50%"])] },
]
const master = [
  { payment_method_id: "master", issuer: { id: "3" }, payer_costs: [pc(1, 0), pc(3, 0), pc(12, 60, ["recommended_installment", "CFT_150,00%|TEA_99,99%"])] },
]

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function fetchPorMedio(respuestas: Record<string, () => Promise<Response>>) {
  return vi.fn(async (url: string) => {
    const medio = new URL(url).searchParams.get("payment_method_id") ?? ""
    const r = respuestas[medio]
    if (!r) throw new Error(`medio inesperado ${medio}`)
    return r()
  })
}

beforeEach(() => {
  limpiarCacheTasas()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("parsearLabelsMP", () => {
  it("CFT y TEA con coma decimal y miles", () => {
    expect(parsearLabelsMP(["recommended_installment", "CFT_1.045,67%|TEA_80,50%"])).toEqual({ cftPct: 1045.67, teaPct: 80.5 })
  })

  it("sin labels → null", () => {
    expect(parsearLabelsMP(undefined)).toEqual({ cftPct: null, teaPct: null })
    expect(parsearLabelsMP(["otra"])).toEqual({ cftPct: null, teaPct: null })
  })
})

describe("normalizarTasasMP", () => {
  it("por cantidad de cuotas: tasa MÁS ALTA entre emisores y marcas, con su CFT/TEA", () => {
    expect(normalizarTasasMP([visa, master])).toEqual([
      { cuotas: 1, tasaPct: 0, cftPct: null, teaPct: null },
      { cuotas: 3, tasaPct: 5.5, cftPct: 12.34, teaPct: 10 },
      { cuotas: 6, tasaPct: 32.14, cftPct: 1045.67, teaPct: 80.5 },
      { cuotas: 12, tasaPct: 60, cftPct: 150, teaPct: 99.99 },
    ])
  })

  it("ignora basura (no array, payer_costs mal formados, tasas negativas)", () => {
    expect(
      normalizarTasasMP([
        { error: "bad_request" },
        [null, { payer_costs: "x" }, { payer_costs: [pc(0, 0), pc(2.5, 0), { installments: 3, installment_rate: "10" }, pc(6, -1), pc(9, 10)] }],
      ]),
    ).toEqual([{ cuotas: 9, tasaPct: 10, cftPct: null, teaPct: null }])
  })
})

describe("textoTasa", () => {
  it("tasa 0 → sin interés", () => {
    expect(textoTasa({ cuotas: 3, tasaPct: 0, cftPct: 0, teaPct: 0 })).toBe("sin interés")
  })

  it("con interés, con y sin CFT (formato es-AR)", () => {
    expect(textoTasa({ cuotas: 6, tasaPct: 32.14, cftPct: 1045.67, teaPct: 80.5 })).toBe("32,14% (CFT 1.045,67%)")
    expect(textoTasa({ cuotas: 6, tasaPct: 20, cftPct: null, teaPct: null })).toBe("20% de interés")
  })
})

describe("obtenerTasasMercadoPago", () => {
  const ahora = new Date("2026-09-17T18:00:00.000Z")

  it("sin public key → sin_clave y no llama a MP", async () => {
    const fetch = vi.fn()
    expect(await obtenerTasasMercadoPago({ publicKey: undefined, fetch, ahora })).toEqual({ estado: "sin_clave" })
    expect(await obtenerTasasMercadoPago({ publicKey: "  ", fetch, ahora })).toEqual({ estado: "sin_clave" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("consulta visa y master con la public key y el monto de referencia", async () => {
    const fetch = fetchPorMedio({ visa: async () => ok(visa), master: async () => ok(master) })
    const r = await obtenerTasasMercadoPago({ publicKey: "APP_USR-pk", fetch, ahora })
    expect(r).toMatchObject({ estado: "ok", consultadoEn: ahora.toISOString() })
    expect(r.estado === "ok" && r.tasas.map((t) => t.cuotas)).toEqual([1, 3, 6, 12])

    expect(fetch).toHaveBeenCalledTimes(2)
    const url = new URL(fetch.mock.calls[0]![0])
    expect(url.origin + url.pathname).toBe("https://api.mercadopago.com/v1/payment_methods/installments")
    expect(url.searchParams.get("public_key")).toBe("APP_USR-pk")
    expect(url.searchParams.get("amount")).toBe(String(MONTO_REFERENCIA))
    expect(MONTO_REFERENCIA).toBe(100000)
  })

  it("una marca falla → usa la otra", async () => {
    const fetch = fetchPorMedio({ visa: async () => new Response("{}", { status: 500 }), master: async () => ok(master) })
    const r = await obtenerTasasMercadoPago({ publicKey: "pk", fetch, ahora })
    expect(r.estado === "ok" && r.tasas.map((t) => t.cuotas)).toEqual([1, 3, 12])
  })

  it("todo falla (HTTP, red, JSON inválido, sin planes) → error, nunca tira", async () => {
    const casos = [
      fetchPorMedio({ visa: async () => new Response("x", { status: 401 }), master: async () => { throw new TypeError("fetch failed") } }),
      fetchPorMedio({ visa: async () => new Response("no json", { status: 200 }), master: async () => ok([]) }),
    ]
    for (const fetch of casos) {
      limpiarCacheTasas()
      await expect(obtenerTasasMercadoPago({ publicKey: "pk", fetch, ahora })).resolves.toEqual({ estado: "error" })
    }
  })

  it("timeout → error", async () => {
    const colgado = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")))),
    )
    await expect(obtenerTasasMercadoPago({ publicKey: "pk", fetch: colgado, ahora, timeoutMs: 5 })).resolves.toEqual({ estado: "error" })
  })

  it("cachea el éxito por TTL (por public key); el error no se cachea", async () => {
    const fetch = fetchPorMedio({ visa: async () => ok(visa), master: async () => ok(master) })
    await obtenerTasasMercadoPago({ publicKey: "pk", fetch, ahora })
    const cacheado = await obtenerTasasMercadoPago({ publicKey: "pk", fetch, ahora: new Date(ahora.getTime() + TTL_MS - 1) })
    expect(cacheado).toMatchObject({ estado: "ok", consultadoEn: ahora.toISOString() })
    expect(fetch).toHaveBeenCalledTimes(2)

    await obtenerTasasMercadoPago({ publicKey: "otra", fetch, ahora })
    expect(fetch).toHaveBeenCalledTimes(4)

    await obtenerTasasMercadoPago({ publicKey: "pk", fetch, ahora: new Date(ahora.getTime() + TTL_MS + 1) })
    expect(fetch).toHaveBeenCalledTimes(6)

    const falla = vi.fn(async () => new Response("", { status: 500 }))
    await obtenerTasasMercadoPago({ publicKey: "rota", fetch: falla, ahora })
    await obtenerTasasMercadoPago({ publicKey: "rota", fetch: falla, ahora })
    expect(falla).toHaveBeenCalledTimes(4)
  })
})
