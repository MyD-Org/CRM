// Validación pura del body del init de comprobantes y de la configuración de mail destino.
// Sin librerías de schema: el body del portal es chico y los errores van por campo,
// en castellano y mostrables (los pinta el modal).

export const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20971520
export const UPLOAD_URL_TTL_SECONDS = 600
export const GET_URL_TTL_SECONDS = 300
export const CONFIRM_LEASE_SECONDS = 120
export const EMAIL_LEASE_SECONDS = 60
export const RECEIPTS_HOURLY_LIMIT = 10
export const RECEIPTS_DAILY_LIMIT = 20
export const MAX_AMOUNT = 999999999999.99
export const MAX_NOTES_CHARS = 500
export const MAX_METHOD_OTHER_CHARS = 80
export const MAX_FILE_NAME_CHARS = 255
export const PAID_ON_MAX_AGE_YEARS = 2

/** Tipos que el cliente puede declarar en el init. Es solo para firmar el PUT: la
 * confianza la da el sniff de magic bytes en el confirm. */
export const DECLARED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const

export const METHODS = ["transferencia", "cheque", "efectivo", "otro"] as const
export type ReceiptMethod = (typeof METHODS)[number]

const AR_TZ = "America/Argentina/Buenos_Aires"

/** "YYYY-MM-DD" de una fecha en la zona horaria Argentina (la del negocio). */
function arYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: AR_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/** Acepta string o number (el modal manda "12345.67"; un llamador programático puede
 * mandar número). Rechaza 0, negativos, >999999999999.99 y más de 2 decimales.
 * Devuelve el monto normalizado a 2 decimales ("150000.5" → "150000.50"). */
export function parseAmount(input: unknown): string | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null
    input = String(input)
  }
  if (typeof input !== "string") return null
  const s = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [intPart = "", decPart = ""] = s.split(".")
  if (intPart.length > 12) return null
  const value = Number(s)
  if (!(value > 0) || value > MAX_AMOUNT) return null
  return decPart ? `${intPart}.${decPart.padEnd(2, "0")}` : intPart
}

/**
 * `paidOn` "YYYY-MM-DD" no futura (en America/Argentina/Buenos_Aires) ni anterior a
 * hoy − 2 años. La comparación se hace contra "hoy" argentino, no contra UTC: a las
 * 23:30 de Argentina (02:30 UTC del día siguiente) "mañana" todavía es futuro.
 */
export function isValidPaidOn(paidOn: unknown, now: Date): boolean {
  if (typeof paidOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return false
  const [y, m, d] = paidOn.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return false // fecha de calendario inválida (p. ej. 2026-02-30)
  }
  const today = arYmd(now)
  if (paidOn > today) return false
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number]
  const min = `${ty - PAID_ON_MAX_AGE_YEARS}-${String(tm).padStart(2, "0")}-${String(td).padStart(2, "0")}`
  return paidOn >= min
}

export interface ParsedInit {
  amount: string
  paidOn: string
  method: ReceiptMethod
  methodOther: string | null
  notes: string | null
  file: { name: string; size: number; contentType: string }
}

export type InitValidation =
  | { ok: true; value: ParsedInit }
  | { ok: false; status: 400; fields: Record<string, string> }
  | { ok: false; status: 413; code: "file_too_large"; error: string }
  | { ok: false; status: 415; code: "unsupported_type"; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Valida el body del init. Devuelve el valor parseado o el error con su status HTTP.
 * Precedencia: 400 (campos) → 415 (tipo declarado) → 413 (tamaño).
 */
export function parseInitBody(body: unknown, now: Date): InitValidation {
  const b = isRecord(body) ? body : {}
  const fields: Record<string, string> = {}

  const amount = parseAmount(b.amount)
  if (amount === null) fields.amount = "Ingresá un monto mayor a 0 (hasta 2 decimales)"

  if (!isValidPaidOn(b.paidOn, now)) fields.paidOn = "Ingresá una fecha de pago válida (no futura)"

  const method = METHODS.find((m) => m === b.method)
  if (!method) {
    fields.method = "Elegí el medio de pago"
  }

  let methodOther: string | null = null
  if (method === "otro") {
    if (typeof b.methodOther !== "string" || b.methodOther.trim().length === 0) {
      fields.methodOther = "Contanos qué medio fue (obligatorio)"
    } else if (b.methodOther.trim().length > MAX_METHOD_OTHER_CHARS) {
      fields.methodOther = `El detalle no puede superar los ${MAX_METHOD_OTHER_CHARS} caracteres`
    } else {
      methodOther = b.methodOther.trim()
    }
  }

  let notes: string | null = null
  if (b.notes !== undefined) {
    if (typeof b.notes !== "string" || b.notes.length > MAX_NOTES_CHARS) {
      fields.notes = `Las notas no pueden superar los ${MAX_NOTES_CHARS} caracteres`
    } else {
      notes = b.notes.trim() || null
    }
  }

  const file = isRecord(b.file) ? b.file : null
  let fileName: string | null = null
  let fileSize: number | null = null
  let contentType: string | null = null
  if (!file) {
    fields.file = "Elegí el archivo del comprobante"
  } else {
    if (typeof file.name !== "string" || file.name.length === 0 || file.name.length > MAX_FILE_NAME_CHARS) {
      fields.file = "El nombre del archivo es inválido"
    } else {
      fileName = file.name
    }
    if (typeof file.size !== "number" || !Number.isInteger(file.size)) {
      fields.file = "El tamaño del archivo es inválido"
    } else {
      fileSize = file.size
    }
    if (typeof file.contentType !== "string") {
      fields.file = "El tipo del archivo es inválido"
    } else {
      contentType = file.contentType
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, status: 400, fields }

  // C: HEIC/HEIF entran por acá (el confirm los convierte a JPEG). El <input accept> del
  // modal sigue pidiendo JPG/PNG/PDF, pero el server acepta los HEIC que se cuelan.
  if (!(DECLARED_CONTENT_TYPES as readonly string[]).includes(contentType as string)) {
    return { ok: false, status: 415, code: "unsupported_type", error: "El tipo de archivo no es válido: subí un PDF, JPG, PNG o WebP" }
  }
  if ((fileSize as number) <= 0 || (fileSize as number) > MAX_FILE_BYTES) {
    return { ok: false, status: 413, code: "file_too_large", error: "El archivo supera el máximo de 20 MB" }
  }

  return {
    ok: true,
    value: {
      amount: amount as string,
      paidOn: b.paidOn as string,
      method: method as ReceiptMethod,
      methodOther,
      notes,
      file: { name: fileName as string, size: fileSize as number, contentType: contentType as string },
    },
  }
}

/**
 * Mail destino de comprobantes (Configuración → Comprobantes). Un solo email:
 * sin comas/punto y coma/CRLF/espacios/<> (eso bloquea la inyección de headers y
 * de destinatarios extra). Vacío ⇒ "" (sin destino, feature apagada). El dominio se
 * normaliza a minúsculas.
 */
export function parseReceiptsEmail(input: unknown): string | null {
  if (typeof input !== "string") return null
  const trimmed = input.trim()
  if (trimmed === "") return ""
  if (trimmed.length > 254) return null
  if (/[,;\s<>]/.test(trimmed)) return null
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null
  const at = trimmed.lastIndexOf("@")
  return trimmed.slice(0, at) + "@" + trimmed.slice(at + 1).toLowerCase()
}
