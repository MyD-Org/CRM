import { describe, it, expect, vi, afterEach } from "vitest"
import { createR2, r2Config, receiptKeys, R2Error, R2TooLargeError, type R2Config } from "@/lib/r2"

const CFG: R2Config = {
  accountId: "fake-account-id",
  accessKeyId: "fake-access-key",
  secretAccessKey: "fake-secret-key-largo-1234567890",
  bucket: "fake-bucket",
  region: "auto",
}

const NOW = new Date("2026-09-12T12:00:00.000Z")

type FetchMock = ReturnType<typeof vi.fn<(input: Request) => Promise<Response>>>

function makeR2(fetchImpl: FetchMock) {
  return createR2(CFG, { fetch: fetchImpl as unknown as typeof fetch, now: () => NOW })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("r2Config", () => {
  it("devuelve las 4 envs con region default auto", () => {
    expect(
      r2Config({
        R2_ACCOUNT_ID: "a",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
        R2_BUCKET: "b",
      }),
    ).toEqual({ accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "b", region: "auto" })
  })

  it("respeta R2_REGION", () => {
    const cfg = r2Config({
      R2_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
      R2_BUCKET: "b",
      R2_REGION: "us-east-1",
    })
    expect(cfg?.region).toBe("us-east-1")
  })

  it("parcial ⇒ null", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(r2Config({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" })).toBeNull()
    expect(r2Config({ R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" })).toBeNull()
    expect(r2Config({})).toBeNull()
    expect(err).toHaveBeenCalledTimes(1) // un solo log por proceso
  })
})

describe("receiptKeys", () => {
  it("arma tmp y final sin nombre del cliente", () => {
    const id = "3f6f8d6e-2f6b-4a1c-9e5d-7b2c4a6d8e0f"
    expect(receiptKeys.tmp("tenant-a", id)).toBe(`tmp/receipts/tenant-a/${id}`)
    expect(receiptKeys.final("tenant-a", id, "pdf", new Date("2026-09-12T12:00:00Z"))).toBe(
      `receipts/tenant-a/2026-09/${id}.pdf`,
    )
  })

  it("rechaza tenantId e id inválidos (path traversal)", () => {
    const id = "3f6f8d6e-2f6b-4a1c-9e5d-7b2c4a6d8e0f"
    expect(() => receiptKeys.tmp("../otro", id)).toThrow()
    expect(() => receiptKeys.tmp("tenant-a", "../../etc/passwd")).toThrow()
    expect(() => receiptKeys.tmp("tenant-a", "no-uuid")).toThrow()
  })
})

describe("presignPut", () => {
  it("firma content-type y content-length (allHeaders) y bucket/key en el path", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>())
    const { url, headers, expiresAt } = await r2.presignPut("tmp/receipts/tenant-a/abc", {
      contentType: "application/pdf",
      contentLength: 1234,
      ttlSeconds: 600,
    })
    const u = new URL(url)
    expect(u.origin).toBe("https://fake-account-id.r2.cloudflarestorage.com")
    expect(u.pathname).toBe("/fake-bucket/tmp/receipts/tenant-a/abc")
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host")
    expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeGreaterThanOrEqual(300)
    expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(600)
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy()
    expect(u.searchParams.get("X-Amz-Credential")).toContain("fake-access-key/")
    expect(headers).toEqual({ "content-type": "application/pdf" })
    expect(expiresAt.getTime()).toBe(NOW.getTime() + 600_000)
  })

  it("es determinista con now fijo", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>())
    const a = await r2.presignPut("tmp/receipts/tenant-a/abc", {
      contentType: "image/png",
      contentLength: 10,
      ttlSeconds: 600,
    })
    const b = await r2.presignPut("tmp/receipts/tenant-a/abc", {
      contentType: "image/png",
      contentLength: 10,
      ttlSeconds: 600,
    })
    expect(a.url).toBe(b.url)
  })
})

describe("presignGet", () => {
  it("lleva response-content-* y TTL en la query", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>())
    const url = await r2.presignGet("receipts/tenant-a/2026-09/abc.pdf", {
      ttlSeconds: 300,
      responseContentDisposition: 'inline; filename="comprobante.pdf"',
      responseContentType: "application/pdf",
    })
    const u = new URL(url)
    expect(u.pathname).toBe("/fake-bucket/receipts/tenant-a/2026-09/abc.pdf")
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300")
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="comprobante.pdf"')
    expect(u.searchParams.get("response-content-type")).toBe("application/pdf")
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })
})

describe("head", () => {
  it("parsea size/content-type/etag", async () => {
    const fetchFn = vi.fn<(input: Request) => Promise<Response>>(async () =>
      new Response(null, {
        status: 200,
        headers: { "content-length": "1234", "content-type": "application/pdf", etag: '"abc"' },
      }),
    )
    const r2 = makeR2(fetchFn)
    const head = await r2.head("tmp/receipts/tenant-a/abc")
    expect(head).toEqual({ size: 1234, contentType: "application/pdf", etag: '"abc"' })
    const req = fetchFn.mock.calls[0]![0] as Request
    expect(req.method).toBe("HEAD")
  })

  it("404 ⇒ null", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(null, { status: 404 })))
    expect(await r2.head("tmp/receipts/tenant-a/abc")).toBeNull()
  })

  it("otro error ⇒ R2Error", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response("boom", { status: 500 })))
    await expect(r2.head("tmp/receipts/tenant-a/abc")).rejects.toBeInstanceOf(R2Error)
  })
})

describe("getRange", () => {
  it("pide bytes=start-end y devuelve el cuerpo", async () => {
    const fetchFn = vi.fn<(input: Request) => Promise<Response>>(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206 }))
    const r2 = makeR2(fetchFn)
    const bytes = await r2.getRange("tmp/receipts/tenant-a/abc", 0, 1023)
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    const req = fetchFn.mock.calls[0]![0] as Request
    expect(req.headers.get("range")).toBe("bytes=0-1023")
  })

  it("404 ⇒ null", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(null, { status: 404 })))
    expect(await r2.getRange("tmp/receipts/tenant-a/abc", 0, 1023)).toBeNull()
  })
})

describe("getObject", () => {
  it("concatena chunks hasta maxBytes", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.enqueue(new Uint8Array([4, 5]))
        c.close()
      },
    })
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(stream, { status: 200 })))
    expect(await r2.getObject("tmp/receipts/tenant-a/abc", { maxBytes: 5 })).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it("aborta la lectura y lanza R2TooLargeError al pasar maxBytes", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
        c.enqueue(new Uint8Array([6, 7, 8, 9, 10]))
        // Sin close(): un stream ya cerrado no dispara el callback de cancel.
      },
      cancel() {
        cancelled = true
      },
    })
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(stream, { status: 200 })))
    await expect(r2.getObject("tmp/receipts/tenant-a/abc", { maxBytes: 8 })).rejects.toBeInstanceOf(R2TooLargeError)
    expect(cancelled).toBe(true)
  })

  it("404 ⇒ null", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(null, { status: 404 })))
    expect(await r2.getObject("tmp/receipts/tenant-a/abc", { maxBytes: 10 })).toBeNull()
  })
})

describe("put y delete", () => {
  it("put firma content-type y content-disposition", async () => {
    const fetchFn = vi.fn<(input: Request) => Promise<Response>>(async () => new Response(null, { status: 200 }))
    const r2 = makeR2(fetchFn)
    await r2.put("receipts/tenant-a/2026-09/abc.pdf", new Uint8Array([1]), {
      contentType: "application/pdf",
      contentDisposition: 'inline; filename="comprobante.pdf"',
    })
    const req = fetchFn.mock.calls[0]![0] as Request
    expect(req.method).toBe("PUT")
    expect(req.headers.get("content-type")).toBe("application/pdf")
    expect(req.headers.get("content-disposition")).toBe('inline; filename="comprobante.pdf"')
  })

  it("put con error ⇒ R2Error", async () => {
    const r2 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response("boom", { status: 403 })))
    await expect(r2.put("k", new Uint8Array([1]), { contentType: "application/pdf" })).rejects.toBeInstanceOf(R2Error)
  })

  it("delete: 204 y 404 ⇒ ok, otro error ⇒ R2Error", async () => {
    const r2ok = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(null, { status: 204 })))
    await expect(r2ok.delete("tmp/receipts/tenant-a/abc")).resolves.toBeUndefined()
    const r2404 = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response(null, { status: 404 })))
    await expect(r2404.delete("tmp/receipts/tenant-a/abc")).resolves.toBeUndefined()
    const r2err = makeR2(vi.fn<(input: Request) => Promise<Response>>(async () => new Response("boom", { status: 500 })))
    await expect(r2err.delete("tmp/receipts/tenant-a/abc")).rejects.toBeInstanceOf(R2Error)
  })
})
