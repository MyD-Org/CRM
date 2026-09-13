// Tests unitarios del confirm con dependencias falsas (repo en memoria, R2 fake, deliver
// espía). Cubre las ramas del design: orden de pasos, upload_missing libera lease, 413s,
// re-sniff tras mutación del tmp, storage_error liberando, publish 0 filas ⇒ in_progress sin
// mail, mail/delete tmp que fallan no cambian el 200, errores de imagen ⇒ 415/422 (receipt-image
// se mockea parcial: acá interesa el mapeo del confirm, la conversión real se testea en
// receipt-image.test.ts). Datos 100% ficticios (tenant-a, @example.com).

import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { confirmReceipt, type ConfirmReceiptRepo } from "@/lib/receipt-confirm"
import type { PaymentReceiptRow } from "@/lib/payment-receipts"
import { R2Error, R2TooLargeError, receiptKeys, type R2Client } from "@/lib/r2"
import { MAX_FILE_BYTES } from "@/lib/receipt-validation"

// normalizeImage mockeado: image/heic ⇒ image_too_large (el resto pasa, no es lo que se
// prueba acá). ReceiptImageError y el resto del módulo quedan reales.
vi.mock("@/lib/receipt-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipt-image")>()
  return {
    ...actual,
    normalizeImage: vi.fn(async (bytes: Uint8Array, mime: string) => {
      if (mime === "image/heic") throw new actual.ReceiptImageError("image_too_large")
      return { bytes, mime }
    }),
  }
})

const TENANT = { id: "tenant-a" }
const CLIENT = { codigocliente: "12345" }
const ORIGIN = "https://tenant-a.example.com"
const NOW = new Date("2026-09-12T10:00:00.000Z")
const RECEIPT_ID = "11111111-2222-4333-8444-555555555555"

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3, 4, 5])
const SVG = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
const HEIC = (() => {
  const b = new Uint8Array(16)
  b.set([0, 0, 0, 0x18], 0)
  b.set(Array.from("ftyp", (c) => c.charCodeAt(0)), 4)
  b.set(Array.from("heic", (c) => c.charCodeAt(0)), 8)
  return b
})()

function row(overrides: Partial<PaymentReceiptRow> = {}): PaymentReceiptRow {
  return {
    id: RECEIPT_ID,
    tenantId: TENANT.id,
    codigocliente: CLIENT.codigocliente,
    razonsocial: "Cliente Demo SRL",
    cuit: "30123456780",
    clientEmail: "cliente@example.com",
    amount: "150000.50",
    currency: "ARS",
    paidOn: "2026-09-10",
    method: "transferencia",
    methodOther: null,
    notes: null,
    status: "uploading",
    processingStartedAt: null,
    rejectReason: null,
    declaredContentType: "application/pdf",
    declaredSize: PDF.length,
    fileKey: null,
    fileMime: null,
    fileSize: null,
    fileOriginalName: null,
    fileSha256: null,
    convertedFrom: null,
    emailStatus: "pending",
    emailError: null,
    emailSentAt: null,
    emailAttempts: 0,
    emailLastAttemptAt: null,
    loadedAt: null,
    loadedBy: null,
    loadedByName: null,
    createdAt: new Date("2026-09-10T12:00:00.000Z"),
    submittedAt: null,
    updatedAt: new Date("2026-09-10T12:00:00.000Z"),
    ...overrides,
  }
}

interface RepoOptions {
  /** Default: fila `processing` (claim exitoso). `null` = claim devuelve 0 filas. */
  claimed?: PaymentReceiptRow | null
  found?: PaymentReceiptRow | null
  /** Default: fila `pending`. `null` = publish afectó 0 filas. */
  published?: PaymentReceiptRow | null
}

function makeRepo(opts: RepoOptions = {}) {
  const claimed = opts.claimed === undefined ? row({ status: "processing" }) : opts.claimed
  const published = opts.published === undefined ? row({ status: "pending" }) : opts.published
  return {
    claimForConfirm: vi.fn<ConfirmReceiptRepo["claimForConfirm"]>(async () => claimed),
    findForClient: vi.fn<ConfirmReceiptRepo["findForClient"]>(async () => opts.found ?? null),
    release: vi.fn<ConfirmReceiptRepo["release"]>(async () => true),
    reject: vi.fn<ConfirmReceiptRepo["reject"]>(async () => {}),
    publish: vi.fn<ConfirmReceiptRepo["publish"]>(async () => published),
    // B: por defecto sin duplicado (el happy path de A no cambia).
    findDuplicateBySha: vi.fn<ConfirmReceiptRepo["findDuplicateBySha"]>(async () => null),
  }
}

interface R2Options {
  head?: { size: number; contentType: string | null; etag: string | null } | null
  getRange?: Uint8Array | null
  getObject?: Uint8Array | null
  getObjectError?: Error
  putError?: Error
  deleteError?: Error
}

function makeR2(opts: R2Options) {
  return {
    presignPut: vi.fn(async () => ({ url: "https://example.com", headers: { "content-type": "application/pdf" }, expiresAt: new Date() })),
    presignGet: vi.fn(async () => "https://example.com"),
    head: vi.fn<R2Client["head"]>(async () =>
      opts.head === undefined ? { size: PDF.length, contentType: "application/pdf", etag: '"etag"' } : opts.head),
    getRange: vi.fn<R2Client["getRange"]>(async (key, start, end) => {
      void key
      if (opts.getRange !== undefined) return opts.getRange
      return PDF.slice(start, end + 1)
    }),
    getObject: vi.fn<R2Client["getObject"]>(async () => {
      if (opts.getObjectError) throw opts.getObjectError
      return opts.getObject === undefined ? PDF : opts.getObject
    }),
    put: vi.fn<R2Client["put"]>(async () => {
      if (opts.putError) throw opts.putError
    }),
    delete: vi.fn<R2Client["delete"]>(async () => {
      if (opts.deleteError) throw opts.deleteError
    }),
  }
}

function setup(repoOpts: RepoOptions = {}, r2Opts: R2Options = {}) {
  const repo = makeRepo(repoOpts)
  const r2 = makeR2(r2Opts)
  const deliver = vi.fn<(receiptId: string, buffer: Uint8Array) => Promise<void>>(async () => {})
  const run = (id: string = RECEIPT_ID) =>
    confirmReceipt(
      { tenant: TENANT, session: CLIENT, id, origin: ORIGIN },
      { repo: repo as ConfirmReceiptRepo, r2: r2 as unknown as R2Client, deliver, now: () => NOW },
    )
  return { repo, r2, deliver, run }
}

describe("confirmReceipt", () => {
  it("happy path: verifica en orden, publica el buffer verificado y responde pending", async () => {
    const { repo, r2, deliver, run } = setup()
    const result = await run()

    expect(result).toEqual({ ok: true, status: "pending" })

    // Orden de pasos: HEAD → range → GET → PUT final → publish → delete tmp → deliver.
    const order = [
      r2.head.mock.invocationCallOrder[0],
      r2.getRange.mock.invocationCallOrder[0],
      r2.getObject.mock.invocationCallOrder[0],
      r2.put.mock.invocationCallOrder[0],
      repo.publish.mock.invocationCallOrder[0],
      r2.delete.mock.invocationCallOrder[0],
      deliver.mock.invocationCallOrder[0],
    ]
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    // PUT final desde el buffer verificado: key, mime sniffeado y disposition inline.
    const finalKey = receiptKeys.final(TENANT.id, RECEIPT_ID, "pdf", NOW)
    expect(r2.put).toHaveBeenCalledTimes(1)
    expect(r2.put.mock.calls[0]?.[0]).toBe(finalKey)
    expect(r2.put.mock.calls[0]?.[2]).toEqual({
      contentType: "application/pdf",
      contentDisposition: `inline; filename="comprobante-2026-09-10-11111111.pdf"`,
    })

    // publish con los datos verificados (sha256 sobre los bytes publicados).
    expect(repo.publish).toHaveBeenCalledTimes(1)
    const [publishFields, publishAt] = [repo.publish.mock.calls[0]?.[2], repo.publish.mock.calls[0]?.[3]]
    expect(publishFields).toEqual({
      fileKey: finalKey,
      fileMime: "application/pdf",
      fileSize: PDF.length,
      fileSha256: createHash("sha256").update(PDF).digest("hex"),
      convertedFrom: null,
    })
    expect(publishAt).toBe(NOW)

    // tmp borrado y mail entregado con el mismo buffer publicado.
    expect(r2.delete).toHaveBeenCalledWith(receiptKeys.tmp(TENANT.id, RECEIPT_ID))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0]).toBe(RECEIPT_ID)
    expect(deliver.mock.calls[0]?.[1]).toBe(PDF)
  })

  it("id que no es UUID ⇒ 404 not_found sin tocar repo ni R2", async () => {
    const { repo, r2, deliver, run } = setup()
    const result = await run("no-es-un-uuid")
    expect(result).toEqual({ ok: false, status: 404, code: "not_found", error: "Comprobante no encontrado" })
    expect(repo.claimForConfirm).not.toHaveBeenCalled()
    expect(r2.head).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("claim 0 filas y fila inexistente/ajena ⇒ 404 not_found", async () => {
    const { repo, r2, run } = setup({ claimed: null, found: null })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 404, code: "not_found" })
    expect(repo.findForClient).toHaveBeenCalledWith(TENANT.id, CLIENT.codigocliente, RECEIPT_ID)
    expect(r2.head).not.toHaveBeenCalled()
  })

  it("claim 0 filas y fila pending (re-confirm) ⇒ 200 idempotente, sin mail ni lectura de R2", async () => {
    const { repo, r2, deliver, run } = setup({ claimed: null, found: row({ status: "pending" }) })
    const result = await run()
    expect(result).toEqual({ ok: true, status: "pending" })
    expect(r2.head).not.toHaveBeenCalled()
    expect(repo.publish).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("claim 0 filas y fila loaded ⇒ 200 idempotente", async () => {
    const { run } = setup({ claimed: null, found: row({ status: "loaded", loadedAt: NOW }) })
    expect(await run()).toEqual({ ok: true, status: "loaded" })
  })

  it("claim 0 filas y processing con lease vivo ⇒ 202 in_progress", async () => {
    const { r2, deliver, run } = setup({ claimed: null, found: row({ status: "processing", processingStartedAt: NOW }) })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 202, code: "in_progress" })
    expect(r2.head).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("claim 0 filas y uploading liberado por otro confirm en vuelo ⇒ 202 in_progress", async () => {
    const { run } = setup({ claimed: null, found: row({ status: "uploading" }) })
    expect(await run()).toMatchObject({ ok: false, status: 202, code: "in_progress" })
  })

  it("claim 0 filas y rejected ⇒ responde el MISMO código del rechazo (no lo resucita)", async () => {
    const { r2, deliver, run } = setup({ claimed: null, found: row({ status: "rejected", rejectReason: "size_mismatch" }) })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 413, code: "size_mismatch" })
    expect(r2.head).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("HEAD 404 ⇒ libera el lease (processing→uploading) y responde 409 upload_missing", async () => {
    const { repo, r2, deliver, run } = setup({}, { head: null })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 409, code: "upload_missing" })
    expect(repo.release).toHaveBeenCalledTimes(1)
    expect(repo.release).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, NOW)
    expect(repo.reject).not.toHaveBeenCalled()
    expect(r2.getObject).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("HEAD con tamaño > 20 MiB ⇒ reject file_too_large (413) y borra el tmp", async () => {
    const { repo, r2, run } = setup({}, { head: { size: MAX_FILE_BYTES + 1, contentType: "application/pdf", etag: null } })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 413, code: "file_too_large" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "file_too_large", NOW)
    expect(r2.delete).toHaveBeenCalledWith(receiptKeys.tmp(TENANT.id, RECEIPT_ID))
    expect(repo.release).not.toHaveBeenCalled()
    expect(repo.publish).not.toHaveBeenCalled()
  })

  it("HEAD con tamaño distinto al declarado ⇒ reject size_mismatch (413)", async () => {
    const { repo, r2, run } = setup({}, { head: { size: PDF.length + 1, contentType: "application/pdf", etag: null } })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 413, code: "size_mismatch" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "size_mismatch", NOW)
    expect(r2.getObject).not.toHaveBeenCalled()
  })

  it("GET range 404 (tmp borrado entre HEAD y range) ⇒ storage_error (502) liberando lease", async () => {
    const { repo, run } = setup({}, { getRange: null })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 502, code: "storage_error" })
    expect(repo.release).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, NOW)
    expect(repo.reject).not.toHaveBeenCalled()
  })

  it("range que no sniffea (SVG disfrazado) ⇒ reject unsupported_type (415) y borra el tmp", async () => {
    const { repo, r2, run } = setup({}, { getRange: SVG })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 415, code: "unsupported_type" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "unsupported_type", NOW)
    expect(r2.getObject).not.toHaveBeenCalled()
    expect(r2.delete).toHaveBeenCalled()
  })

  it("GET completo que excede 20 MiB (R2TooLargeError) ⇒ reject file_too_large (413)", async () => {
    const { repo, run } = setup({}, { getObjectError: new R2TooLargeError(MAX_FILE_BYTES) })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 413, code: "file_too_large" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "file_too_large", NOW)
  })

  it("GET completo 404 ⇒ storage_error (502) liberando lease", async () => {
    const { repo, run } = setup({}, { getObject: null })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 502, code: "storage_error" })
    expect(repo.release).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, NOW)
  })

  it("bytes bajados con longitud distinta a la declarada ⇒ reject size_mismatch (413)", async () => {
    const mutated = new Uint8Array(PDF.length + 1)
    mutated.set(PDF, 0)
    const { repo, run } = setup({}, { getObject: mutated })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 413, code: "size_mismatch" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "size_mismatch", NOW)
  })

  it("tmp mutado entre el range y el GET (mismo tamaño, cambió el mime) ⇒ reject unsupported_type (415)", async () => {
    // El range sniffea PDF pero el GET completo devuelve JPEG de la MISMA longitud: el PUT del
    // cliente pudo pisar el tmp entre el sniff y la bajada (TOCTOU) — lo atrapa el re-sniff.
    const mutatedSameSize = new Uint8Array(PDF.length)
    mutatedSameSize.set([0xff, 0xd8, 0xff, 0xe0], 0)
    const { repo, run } = setup({}, { getRange: PDF, getObject: mutatedSameSize })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 415, code: "unsupported_type" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "unsupported_type", NOW)
  })

  it("image_too_large del procesamiento ⇒ reject 415 sin publish", async () => {
    const { repo, r2, run } = setup(
      { claimed: row({ status: "processing", declaredContentType: "image/heic", declaredSize: HEIC.length }) },
      { head: { size: HEIC.length, contentType: "image/heic", etag: null }, getRange: HEIC, getObject: HEIC },
    )
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 415, code: "image_too_large" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "image_too_large", NOW)
    expect(r2.put).not.toHaveBeenCalled()
  })

  it("processing_failed del procesamiento ⇒ reject 422 sin publish", async () => {
    const { normalizeImage, ReceiptImageError } = await import("@/lib/receipt-image")
    vi.mocked(normalizeImage).mockRejectedValueOnce(new ReceiptImageError("processing_failed"))
    const { repo, r2, run } = setup(
      { claimed: row({ status: "processing", declaredContentType: "image/heic", declaredSize: HEIC.length }) },
      { head: { size: HEIC.length, contentType: "image/heic", etag: null }, getRange: HEIC, getObject: HEIC },
    )
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 422, code: "processing_failed" })
    expect(repo.reject).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, "processing_failed", NOW)
    expect(r2.put).not.toHaveBeenCalled()
  })

  it("falla del PUT final ⇒ storage_error (502) liberando lease, sin publish", async () => {
    const { repo, r2, deliver, run } = setup({}, { putError: new R2Error("put", 500, "PUT respondió 500") })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 502, code: "storage_error" })
    expect(repo.release).toHaveBeenCalledWith(TENANT.id, RECEIPT_ID, NOW)
    expect(repo.publish).not.toHaveBeenCalled()
    expect(r2.delete).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it("publish con 0 filas (lease perdido) ⇒ 202 in_progress, sin mail y sin borrar el tmp", async () => {
    const { repo, r2, deliver, run } = setup({ published: null })
    const result = await run()
    expect(result).toMatchObject({ ok: false, status: 202, code: "in_progress" })
    expect(deliver).not.toHaveBeenCalled()
    expect(r2.delete).not.toHaveBeenCalled()
    expect(repo.release).not.toHaveBeenCalled()
  })

  it("el mail que falla NO cambia el 200", async () => {
    const { deliver, run } = setup()
    deliver.mockRejectedValue(new Error("Resend caído"))
    const result = await run()
    expect(result).toEqual({ ok: true, status: "pending" })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("el delete del tmp que falla NO cambia el 200 (el lifecycle lo cubre)", async () => {
    const { r2, run } = setup({}, { deleteError: new R2Error("delete", 500, "DELETE respondió 500") })
    const result = await run()
    expect(result).toEqual({ ok: true, status: "pending" })
    expect(r2.delete).toHaveBeenCalledTimes(1)
  })
})
