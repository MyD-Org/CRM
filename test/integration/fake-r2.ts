import { randomUUID } from "node:crypto"
import { getDb } from "@/db"
import { paymentReceipts } from "@/db/schema"
import { R2TooLargeError, type R2Client } from "@/lib/r2"

// R2Client falso para los tests de integración de comprobantes: los bytes viven en un Map en
// memoria, con contadores de llamadas por operación (para aserciones de "exactly once"),
// fallas inyectables por key y un hook post-getRange para el test del TOCTOU (mutar el tmp
// entre el sniff del range y el GET completo). Nadie toca R2 real desde los tests.
//
// El holder que las rutas mockeadas consultan (`r2Holder`) vive en cada archivo de test con
// `vi.hoisted` — no acá — para evitar una dependencia circular con el mock de "@/lib/r2".

export interface StoredObject {
  body: Uint8Array
  contentType: string | null
}

export class FakeR2 implements R2Client {
  readonly objects = new Map<string, StoredObject>()
  readonly calls = { presignPut: 0, presignGet: 0, head: 0, getRange: 0, getObject: 0, put: 0, delete: 0 }
  /** Error a lanzar en CUALQUIER operación que toque esa key (falla inyectable). */
  readonly failures = new Map<string, Error>()
  /** URLs firmadas emitidas (para aserciones; nadie las llama de verdad). */
  readonly presignedUrls: string[] = []
  /** Hook TOCTOU: corre DESPUÉS de servir un getRange (el confirm hace range → GET completo:
   *  acá el test puede mutar el tmp para que el re-sniff rechace). */
  onAfterGetRange: ((key: string) => void) | null = null

  private failIfInjected(key: string): void {
    const err = this.failures.get(key)
    if (err) throw err
  }

  async presignPut(
    key: string,
    o: { contentType: string; contentLength: number; ttlSeconds: number },
  ): Promise<{ url: string; headers: { "content-type": string }; expiresAt: Date }> {
    this.calls.presignPut += 1
    this.failIfInjected(key)
    const url = `https://fake-r2.test/${key}?sig=put-${this.calls.presignPut}`
    this.presignedUrls.push(url)
    return { url, headers: { "content-type": o.contentType }, expiresAt: new Date(Date.now() + o.ttlSeconds * 1000) }
  }

  async presignGet(key: string): Promise<string> {
    this.calls.presignGet += 1
    this.failIfInjected(key)
    const url = `https://fake-r2.test/${key}?sig=get-${this.calls.presignGet}`
    this.presignedUrls.push(url)
    return url
  }

  async head(key: string): Promise<{ size: number; contentType: string | null; etag: string | null } | null> {
    this.calls.head += 1
    this.failIfInjected(key)
    const obj = this.objects.get(key)
    if (!obj) return null
    return { size: obj.body.length, contentType: obj.contentType, etag: `"${obj.body.length}"` }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null> {
    this.calls.getRange += 1
    this.failIfInjected(key)
    const obj = this.objects.get(key)
    if (!obj) return null
    const slice = obj.body.slice(start, endInclusive + 1)
    // El hook corre antes de devolver: simula que el tmp cambia entre el sniff y el GET.
    this.onAfterGetRange?.(key)
    return slice
  }

  async getObject(key: string, o: { maxBytes: number }): Promise<Uint8Array | null> {
    this.calls.getObject += 1
    this.failIfInjected(key)
    const obj = this.objects.get(key)
    if (!obj) return null
    if (obj.body.length > o.maxBytes) throw new R2TooLargeError(o.maxBytes)
    return obj.body.slice()
  }

  async put(key: string, body: Uint8Array, o: { contentType: string; contentDisposition?: string }): Promise<void> {
    this.calls.put += 1
    this.failIfInjected(key)
    this.objects.set(key, { body: body.slice(), contentType: o.contentType })
  }

  async delete(key: string): Promise<void> {
    this.calls.delete += 1
    this.objects.delete(key)
  }

  /** Keys de objetos bajo un prefijo (p. ej. "receipts/" para asertar que no quedó nada). */
  keysWithPrefix(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix))
  }
}

type ReceiptInsert = typeof paymentReceipts.$inferInsert

/**
 * Inserta una fila de payment_receipts directo por drizzle (sin pasar por las rutas), con
 * defaults de un comprobante `pending` publicado hoy. Los overrides permiten llevarla a
 * cualquier estado (uploading/processing/rejected, createdAt en el pasado, etc.).
 */
export async function seedReceipt(
  tenantId: string,
  codigocliente: string,
  overrides: Partial<ReceiptInsert> = {},
): Promise<typeof paymentReceipts.$inferSelect> {
  const id = randomUUID()
  const now = new Date()
  const values: ReceiptInsert = {
    id,
    tenantId,
    codigocliente,
    razonsocial: "Cliente de Ejemplo S.A.",
    cuit: "30-71234567-8",
    clientEmail: "cliente@example.com",
    amount: "1500.00",
    paidOn: "2026-09-10",
    method: "transferencia",
    declaredContentType: "application/pdf",
    declaredSize: 12345,
    status: "pending",
    fileKey: `receipts/${tenantId}/2026-09/${id}.pdf`,
    fileMime: "application/pdf",
    fileSize: 12345,
    fileSha256: "a".repeat(64),
    submittedAt: now,
    createdAt: now,
    ...overrides,
  }
  // CHECK payment_receipts_loaded_at: loaded exige loaded_at (y el nombre va de yapa).
  if (values.status === "loaded") {
    values.loadedAt ??= now
    values.loadedByName ??= "Ana Admin"
  }
  const [row] = await getDb().insert(paymentReceipts).values(values).returning()
  return row
}
