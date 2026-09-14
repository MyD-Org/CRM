// Orquestación del confirm de un comprobante. Verifica leyendo desde R2 (los bytes NUNCA
// pasan por la función del route ni por el proxy: el navegador subió directo con URL
// prefirmada) y publica con PUT desde el buffer verificado — nunca CopyObject (D2: cierra el
// TOCTOU entre el sniff y la publicación).
//
// Pasos (design): claim (lease 120 s) → HEAD tmp → GET range + sniff → GET completo (tope
// 20 MB) → re-sniff → processReceiptFile → sha256 → PUT final → publish → delete tmp
// (best-effort) → delivery (try/catch: el mail NUNCA cambia el 200).
//
// Las dependencias se inyectan para testear con fakes; la ruta (A4) arma el wiring real con
// `import * as repo from "@/lib/payment-receipts"`, `getR2()` y `deliverReceiptEmail`.

import { createHash } from "node:crypto"
import { processReceiptFile, sniffMime, extFor } from "@/lib/receipt-file"
import { ReceiptImageError } from "@/lib/receipt-image"
import type { PaymentReceiptRow, PublishFields } from "@/lib/payment-receipts"
import { R2TooLargeError, receiptKeys, type R2Client } from "@/lib/r2"
import { MAX_FILE_BYTES } from "@/lib/receipt-validation"

/** Subconjunto estructural del repo que usa el confirm: cualquier fake con estas firmas sirve. */
export interface ConfirmReceiptRepo {
  claimForConfirm(tenantId: string, codigocliente: string, id: string, now: Date): Promise<PaymentReceiptRow | null>
  findForClient(tenantId: string, codigocliente: string, id: string): Promise<PaymentReceiptRow | null>
  release(tenantId: string, id: string, now: Date): Promise<boolean>
  reject(tenantId: string, id: string, reason: string, now: Date): Promise<void>
  publish(tenantId: string, id: string, fields: PublishFields, at: Date): Promise<PaymentReceiptRow | null>
  /** B: aviso de duplicado — mismo cliente+tenant, mismo sha256 ya publicado, otro id. */
  findDuplicateBySha(
    tenantId: string,
    codigocliente: string,
    sha256: string,
    excludeId: string,
  ): Promise<{ id: string; submittedAt: Date } | null>
}

export interface ConfirmReceiptInput {
  tenant: { id: string }
  session: { codigocliente: string }
  id: string
  /** Origen absoluto del request: lo usa `deliver` para el link del mail. */
  origin: string
}

export interface ConfirmReceiptDeps {
  repo: ConfirmReceiptRepo
  r2: R2Client
  /** Envío del mail (try/catch acá adentro nunca cambia el resultado). Recibe el buffer
   *  publicado para adjuntarlo sin releer de R2 y el duplicado detectado (B), para el
   *  aviso "Posible duplicado…" del mail. */
  deliver: (receiptId: string, buffer: Uint8Array, duplicateOf: { id: string; submittedAt: Date } | null) => Promise<unknown>
  now?: () => Date
}

export type ConfirmResult =
  | { ok: true; status: "pending" | "loaded"; duplicateOf?: { id: string; submittedAt: Date } | null }
  | { ok: false; status: number; code: string; error: string }

const CONFIRM_ERRORS = {
  not_found: { status: 404, error: "Comprobante no encontrado" },
  in_progress: { status: 202, error: "El comprobante se está procesando, intente nuevamente en unos segundos" },
  upload_missing: { status: 409, error: "Todavía no recibimos el archivo del comprobante" },
  file_too_large: { status: 413, error: "El archivo supera el máximo de 20 MB" },
  size_mismatch: { status: 413, error: "El archivo no coincide con lo declarado al informar el pago" },
  unsupported_type: { status: 415, error: "El tipo de archivo no es válido: suba un PDF, JPG, PNG o WebP" },
  image_too_large: { status: 415, error: "La imagen es demasiado grande" },
  processing_failed: { status: 422, error: "No pudimos procesar la imagen" },
  storage_error: { status: 502, error: "No pudimos verificar el archivo, intente nuevamente en unos minutos" },
} as const

export type ConfirmErrorCode = keyof typeof CONFIRM_ERRORS

// El reintento de un `rejected` responde el MISMO código con el que se rechazó (reject_reason
// lo escribió este módulo: solo estos códulos existen). Un reintento no lo resucita.
const REJECTED_ERROR_BY_CODE: Record<string, { status: number; error: string }> = {
  file_too_large: CONFIRM_ERRORS.file_too_large,
  size_mismatch: CONFIRM_ERRORS.size_mismatch,
  unsupported_type: CONFIRM_ERRORS.unsupported_type,
  image_too_large: CONFIRM_ERRORS.image_too_large,
  processing_failed: CONFIRM_ERRORS.processing_failed,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function confirmReceipt(input: ConfirmReceiptInput, deps: ConfirmReceiptDeps): Promise<ConfirmResult> {
  const { tenant, session, id } = input
  const { repo, r2, deliver } = deps
  const now = deps.now ?? (() => new Date())

  const fail = (code: ConfirmErrorCode): ConfirmResult => ({ ok: false, code, ...CONFIRM_ERRORS[code] })

  // 1. Un id que no es UUID se responde como inexistente: nunca llega a la DB (evita el
  //    22P02 que Postgres devolvería como 500).
  if (!UUID_RE.test(id)) return fail("not_found")

  // 2. Claim atómico del lease (120 s). 0 filas ⇒ mirar la fila para decidir.
  const claimed = await repo.claimForConfirm(tenant.id, session.codigocliente, id, now())
  if (!claimed) {
    const row = await repo.findForClient(tenant.id, session.codigocliente, id)
    if (!row) return fail("not_found")
    if (row.status === "pending" || row.status === "loaded") return { ok: true, status: row.status }
    // processing con lease vivo, o uploading liberado por otro confirm en flight: reintentar.
    if (row.status === "processing" || row.status === "uploading") return fail("in_progress")
    const meta = REJECTED_ERROR_BY_CODE[row.rejectReason ?? ""]
    if (meta) return { ok: false, code: row.rejectReason as string, ...meta }
    return { ok: false, status: 422, code: "rejected", error: "El comprobante fue rechazado" }
  }

  const tmpKey = receiptKeys.tmp(tenant.id, id)

  // "reject X" = processing→rejected + DELETE tmp best-effort + responder X.
  const reject = async (code: ConfirmErrorCode): Promise<ConfirmResult> => {
    await repo.reject(tenant.id, id, code, now())
    await r2.delete(tmpKey).catch((err) => console.warn(`[confirm] delete tmp tras ${code}:`, err))
    return fail(code)
  }

  // Error de storage = liberar el lease (processing→uploading, reintentable) + 502.
  const storageError = async (cause: unknown): Promise<ConfirmResult> => {
    console.error(`[confirm] storage_error en ${id}:`, cause)
    await repo.release(tenant.id, id, now()).catch((err) => console.error("[confirm] release falló:", err))
    return fail("storage_error")
  }

  try {
    // 3. HEAD: el tmp tiene que existir y matchear lo declarado en el init.
    const head = await r2.head(tmpKey)
    if (!head) {
      // No se subió (o el lifecycle lo borró): liberar el lease para que pueda reintentar.
      await repo.release(tenant.id, id, now())
      return fail("upload_missing")
    }
    if (head.size > MAX_FILE_BYTES) return reject("file_too_large")
    if (head.size !== claimed.declaredSize) return reject("size_mismatch")

    // 4. Range de los primeros 1024 bytes + sniff barato (no bajar 20 MB de basura).
    const headBytes = await r2.getRange(tmpKey, 0, 1023)
    if (headBytes === null) return storageError(new Error("el tmp desapareció entre el HEAD y el GET"))
    const rangeMime = sniffMime(headBytes)
    if (rangeMime === null) return reject("unsupported_type")

    // 5. GET completo con tope duro de 20 MB.
    let bytes: Uint8Array | null
    try {
      bytes = await r2.getObject(tmpKey, { maxBytes: MAX_FILE_BYTES })
    } catch (err) {
      if (err instanceof R2TooLargeError) return reject("file_too_large")
      throw err
    }
    if (bytes === null) return storageError(new Error("el tmp desapareció entre el HEAD y el GET"))
    if (bytes.length !== claimed.declaredSize) return reject("size_mismatch")

    // 6. Re-sniff sobre los bytes completos: el tmp pudo cambiar entre el range y el GET
    //    (la URL PUT sigue viva). Si el mime cambió o ya no se reconoce, se rechaza.
    const mime = sniffMime(bytes)
    if (mime === null || mime !== rangeMime) return reject("unsupported_type")

    // 7. Procesamiento (C): PDF pasa igual; imágenes se normalizan (HEIC/HEIF ⇒ JPEG, y
    //    jpeg/png/webp re-encodados sin EXIF). Errores tipados: image_too_large 415,
    //    processing_failed 422.
    let processed: Awaited<ReturnType<typeof processReceiptFile>>
    try {
      processed = await processReceiptFile(bytes, mime)
    } catch (err) {
      if (err instanceof ReceiptImageError) return reject(err.code)
      throw err
    }

    // 8-9. sha256 sobre los bytes que se van a publicar + PUT final desde ESE buffer.
    const sha256 = createHash("sha256").update(processed.bytes).digest("hex")
    const submittedAt = now()
    const ext = extFor(processed.mime)
    const finalKey = receiptKeys.final(tenant.id, id, ext, submittedAt)
    await r2.put(finalKey, processed.bytes, {
      contentType: processed.mime,
      contentDisposition: `inline; filename="comprobante-${claimed.paidOn}-${id.slice(0, 8)}.${ext}"`,
    })

    // 10. Publicar. 0 filas = otro confirm retomó el lease y publicó: in_progress, sin mail
    //     y sin borrar el tmp (puede estar en uso todavía).
    const published = await repo.publish(tenant.id, id, {
      fileKey: finalKey,
      fileMime: processed.mime,
      fileSize: processed.bytes.length,
      fileSha256: sha256,
      convertedFrom: processed.convertedFrom,
    }, submittedAt)
    if (!published) return fail("in_progress")

    // B: aviso de duplicado (NO bloquea): el mismo cliente ya había publicado estos mismos
    // bytes (mismo sha256). Va en la respuesta y en el mail; la fila se publica igual.
    const duplicateOf = await repo.findDuplicateBySha(tenant.id, session.codigocliente, sha256, id)

    // 11. DELETE tmp best-effort: el lifecycle (1 día) cubre lo que escapes del catch.
    await r2.delete(tmpKey).catch((err) => console.warn(`[confirm] delete tmp ${tmpKey}:`, err))

    // 12. El mail NUNCA cambia el resultado del confirm.
    try {
      await deliver(id, processed.bytes, duplicateOf)
    } catch (err) {
      console.error(`[confirm] delivery falló para ${id}:`, err)
    }

    // 13. OK publicado. `duplicateOf` solo va cuando existe (contrato: campo opcional).
    return { ok: true, status: "pending", ...(duplicateOf ? { duplicateOf } : {}) }
  } catch (err) {
    return storageError(err)
  }
}
