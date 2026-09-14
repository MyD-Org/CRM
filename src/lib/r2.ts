import { AwsV4Signer } from "aws4fetch"

// Cliente de R2 (Cloudflare) sobre el protocolo S3. La región va siempre en "auto": R2 no
// tiene regiones en el sentido de S3, pero la firma SigV4 exige el campo igual.
//
// El archivo NUNCA pasa por esta función: el navegador sube directo a R2 con una URL PUT
// prefirmada (presignPut) y el admin mira con una URL GET firmada corta (presignGet). Acá
// solo se firma, se lee para verificar (head/getRange/getObject) y se publica (put/delete).

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** R2_REGION, default "auto" (no cuenta para "las 4 o ninguna"). */
  region: string
}

const REQUIRED_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const

let configWarned = false

/**
 * Las 4 (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) o null.
 * Parcial ⇒ null + un console.error por proceso (sin esto, un log por request inundaría).
 */
export function r2Config(env: Record<string, string | undefined> = process.env): R2Config | null {
  const values = REQUIRED_ENV.map((name) => env[name])
  if (values.every((v) => typeof v === "string" && v.length > 0)) {
    const [accountId, accessKeyId, secretAccessKey, bucket] = values as [string, string, string, string]
    return { accountId, accessKeyId, secretAccessKey, bucket, region: env.R2_REGION ?? "auto" }
  }
  if (!configWarned) {
    configWarned = true
    const missing = REQUIRED_ENV.filter((name) => !env[name])
    console.error(`[r2] config incompleta (faltan ${missing.join(", ")}): storage de comprobantes deshabilitado`)
  }
  return null
}

export class R2Error extends Error {
  constructor(
    readonly op: "head" | "get" | "put" | "delete" | "presign",
    readonly status: number | null,
    message: string,
  ) {
    super(message)
    this.name = "R2Error"
  }
}

export class R2TooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`el objeto supera el límite de ${limit} bytes`)
    this.name = "R2TooLargeError"
  }
}

export interface R2Deps {
  fetch?: typeof fetch
  now?: () => Date
}

export interface R2Client {
  /** URL PUT firmada por query con content-type y content-length DENTRO de la firma
   * (allHeaders:true): R2 rechaza con 403 un PUT cuyo tipo o tamaño no matcheen. */
  presignPut(
    key: string,
    o: { contentType: string; contentLength: number; ttlSeconds: number },
  ): Promise<{ url: string; headers: { "content-type": string }; expiresAt: Date }>
  /** URL GET firmada. responseContentDisposition/Type van como response-content-* en la query. */
  presignGet(
    key: string,
    o: { ttlSeconds: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string>
  /** null = 404. */
  head(key: string): Promise<{ size: number; contentType: string | null; etag: string | null } | null>
  /** 206/200; null = 404. */
  getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null>
  /** Lee el objeto completo abortando la lectura y lanzando R2TooLargeError al pasar maxBytes. */
  getObject(key: string, o: { maxBytes: number }): Promise<Uint8Array | null>
  put(key: string, body: Uint8Array, o: { contentType: string; contentDisposition?: string }): Promise<void>
  /** 204/404 ⇒ ok. */
  delete(key: string): Promise<void>
}

const TENANT_ID_RE = /^[a-z0-9-]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertKeyPart(label: string, value: string, re: RegExp): void {
  if (!re.test(value)) throw new Error(`${label} inválido para key de R2: ${JSON.stringify(value)}`)
}

/** Layout de keys. El primer segmento decide la retención (la lifecycle rule matchea por
 * prefijo): `tmp/` se borra a 1 día, `receipts/` no expira nunca (respaldo contable).
 * Nunca nombre original, codigocliente ni CUIT en la key. */
export const receiptKeys = {
  tmp: (tenantId: string, id: string): string => {
    assertKeyPart("tenantId", tenantId, TENANT_ID_RE)
    assertKeyPart("id", id, UUID_RE)
    return `tmp/receipts/${tenantId}/${id}`
  },
  final: (tenantId: string, id: string, ext: string, submittedAt: Date): string => {
    assertKeyPart("tenantId", tenantId, TENANT_ID_RE)
    assertKeyPart("id", id, UUID_RE)
    const yyyyMm = `${submittedAt.getUTCFullYear()}-${String(submittedAt.getUTCMonth() + 1).padStart(2, "0")}`
    return `receipts/${tenantId}/${yyyyMm}/${id}.${ext}`
  },
}

function endpointFor(cfg: R2Config, key: string): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`
}

const amzDatetime = (d: Date): string => d.toISOString().replace(/[:-]|\.\d{3}/g, "")

export function createR2(cfg: R2Config, deps: R2Deps = {}): R2Client {
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  // Cache de credenciales derivadas por fecha: sin esto cada firma re-haría las 4 HMACs.
  const cache = new Map<string, ArrayBuffer>()

  async function signedRequest(
    method: string,
    key: string,
    init: { headers?: HeadersInit; body?: BodyInit },
  ): Promise<Response> {
    const signer = new AwsV4Signer({
      method,
      url: endpointFor(cfg, key),
      headers: init.headers,
      body: init.body,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region,
      cache,
      datetime: amzDatetime(now()),
    })
    const signed = await signer.sign()
    return fetchFn(new Request(signed.url.toString(), { method: signed.method, headers: signed.headers, body: signed.body }))
  }

  async function presign(
    method: "GET" | "PUT",
    key: string,
    init: { headers?: HeadersInit; query?: [string, string][] },
  ): Promise<string> {
    const url = new URL(endpointFor(cfg, key))
    for (const [k, v] of init.query ?? []) url.searchParams.set(k, v)
    const signer = new AwsV4Signer({
      method,
      url: url.toString(),
      headers: init.headers,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region,
      cache,
      datetime: amzDatetime(now()),
      signQuery: true,
      allHeaders: true,
    })
    const signed = await signer.sign()
    return signed.url.toString()
  }

  return {
    async presignPut(key, o) {
      const url = await presign("PUT", key, {
        headers: { "content-type": o.contentType, "content-length": String(o.contentLength) },
        query: [["X-Amz-Expires", String(o.ttlSeconds)]],
      })
      return { url, headers: { "content-type": o.contentType }, expiresAt: new Date(now().getTime() + o.ttlSeconds * 1000) }
    },

    async presignGet(key, o) {
      const query: [string, string][] = [["X-Amz-Expires", String(o.ttlSeconds)]]
      if (o.responseContentDisposition) query.push(["response-content-disposition", o.responseContentDisposition])
      if (o.responseContentType) query.push(["response-content-type", o.responseContentType])
      return presign("GET", key, { query })
    },

    async head(key) {
      const res = await signedRequest("HEAD", key, {})
      if (res.status === 404) return null
      if (!res.ok) throw new R2Error("head", res.status, `HEAD ${key} respondió ${res.status}`)
      const size = Number(res.headers.get("content-length") ?? "0")
      return { size, contentType: res.headers.get("content-type"), etag: res.headers.get("etag") }
    },

    async getRange(key, start, endInclusive) {
      const res = await signedRequest("GET", key, { headers: { range: `bytes=${start}-${endInclusive}` } })
      if (res.status === 404) return null
      if (!res.ok) throw new R2Error("get", res.status, `GET range ${key} respondió ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },

    async getObject(key, o) {
      const res = await signedRequest("GET", key, {})
      if (res.status === 404) return null
      if (!res.ok) throw new R2Error("get", res.status, `GET ${key} respondió ${res.status}`)
      if (res.body === null) {
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.length > o.maxBytes) throw new R2TooLargeError(o.maxBytes)
        return buf
      }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > o.maxBytes) {
            // Abortamos la descarga apenas pasamos el tope: un objeto grande no debe
            // seguir bajando ni quedar en memoria entero.
            await reader.cancel().catch(() => {})
            throw new R2TooLargeError(o.maxBytes)
          }
          chunks.push(value)
        }
      } catch (err) {
        if (err instanceof R2TooLargeError) throw err
        await reader.cancel().catch(() => {})
        throw err
      }
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    },

    async put(key, body, o) {
      const headers: Record<string, string> = {
        "content-type": o.contentType,
        // R2 rechaza con 411 Length Required un PUT chunked: el buffer está en memoria y el
        // largo es exacto, pero hay que declararlo — inferirlo depende del runtime de fetch
        // (en Vercel llegó chunked y el confirm explotó con storage_error).
        "content-length": String(body.byteLength),
      }
      if (o.contentDisposition) headers["content-disposition"] = o.contentDisposition
      // Uint8Array genérico (ArrayBufferLike) no calza con BodyInit de TS 5.7+; el
      // runtime acepta cualquier Uint8Array.
      const res = await signedRequest("PUT", key, { headers, body: body as unknown as BodyInit })
      if (!res.ok) throw new R2Error("put", res.status, `PUT ${key} respondió ${res.status}`)
    },

    async delete(key) {
      const res = await signedRequest("DELETE", key, {})
      if (res.status === 404 || res.ok) return
      throw new R2Error("delete", res.status, `DELETE ${key} respondió ${res.status}`)
    },
  }
}

let cached: R2Client | null | undefined

/** Memoizado por proceso; null si no hay config. Es lo que mockean los tests de rutas. */
export function getR2(): R2Client | null {
  if (cached !== undefined) return cached
  const cfg = r2Config()
  cached = cfg ? createR2(cfg) : null
  return cached
}
