import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { pingShopRevalidarCuotas, PING_TIMEOUT_MS } from "@/lib/shop-revalidar"

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  vi.stubEnv("SHOP_INTERNAL_URL", "https://shop.test/")
  vi.stubEnv("SHOP_CRM_SECRET", "s3cr3t")
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("pingShopRevalidarCuotas", () => {
  it("POST sin body con Bearer al endpoint de revalidación; 200 → propagado", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(pingShopRevalidarCuotas()).resolves.toEqual({ propagado: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://shop.test/api/internal/cuotas/revalidar")
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer s3cr3t")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("502 → no propagado, sin tirar", async () => {
    fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502 }))
    await expect(pingShopRevalidarCuotas()).resolves.toEqual({ propagado: false })
  })

  it("error de red → no propagado, sin tirar", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    await expect(pingShopRevalidarCuotas()).resolves.toEqual({ propagado: false })
  })

  it("timeout de 5 s → no propagado", async () => {
    expect(PING_TIMEOUT_MS).toBe(5000)
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        }),
    )
    const p = pingShopRevalidarCuotas()
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS)
    await expect(p).resolves.toEqual({ propagado: false })
  })

  it("sin SHOP_INTERNAL_URL → no-op (no llama a fetch)", async () => {
    vi.stubEnv("SHOP_INTERNAL_URL", "")
    await expect(pingShopRevalidarCuotas()).resolves.toEqual({ propagado: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sin SHOP_CRM_SECRET → no-op (no manda un Bearer vacío)", async () => {
    vi.stubEnv("SHOP_CRM_SECRET", "")
    await expect(pingShopRevalidarCuotas()).resolves.toEqual({ propagado: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
