// Validación del archivo de comprobante. El tipo real se decide SOLO por magic bytes:
// el content-type declarado y la extensión no otorgan confianza (un SVG disfrazado de
// png tiene que rechazarse igual). processReceiptFile es el único punto de extensión
// del pipeline: la entrega C convierte HEIC/HEIF a JPEG y re-encoda jpeg/png/webp sin
// EXIF (ver receipt-image.ts); los PDF pasan de largo, sin tocar.

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"])

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false
  return magic.every((b, i) => bytes[offset + i] === b)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return ""
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/**
 * Clasifica los primeros ≤1024 bytes por firma. Devuelve el mime real o null si no está
 * en la allowlist (SVG, HTML, ZIP/Office, texto, vacío, …). El mime declarado no participa.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg"
  if (startsWith(bytes, PNG_MAGIC)) return "image/png"
  // WebP: "RIFF" + 4 bytes de tamaño + "WEBP".
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") return "image/webp"
  // HEIC/HEIF: caja "ftyp" en offset 4 y major brand en 8..11. Se chequea antes que PDF
  // porque el brand importa, no la firma.
  if (ascii(bytes, 4, 4) === "ftyp" && HEIC_BRANDS.has(ascii(bytes, 8, 4))) {
    const brand = ascii(bytes, 8, 4)
    return brand === "mif1" || brand === "msf1" ? "image/heif" : "image/heic"
  }
  // PDF: la spec tolera basura previa al header, así que se busca en todo el primer KB.
  const limit = Math.min(bytes.length, 1024) - PDF_MAGIC.length
  for (let i = 0; i <= limit; i++) {
    if (startsWith(bytes, PDF_MAGIC, i)) return "application/pdf"
  }
  return null
}

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
}

/** Extensión de archivo según el mime REAL (sniffeado o convertido), nunca el declarado. */
export function extFor(mime: string): string {
  return EXT_BY_MIME[mime] ?? "bin"
}

const FILENAME_MAX = 80

/**
 * `file_original_name` es solo informativo: sanea para que no pueda usarse como vector
 * (path traversal, NUL, headers de descarga). NFKD + sin diacríticos, sin controles ni
 * separadores, colapsado a [A-Za-z0-9_.-], ≤80 chars, con la extensión re-derivada del
 * mime real. No se usa en keys de R2 ni en headers sin escape.
 */
export function sanitizeFilename(name: string, mime: string): string {
  const ext = extFor(mime)
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // marcas de combinación (diacríticos)
    .replace(/[\u0000-\u001f\u007f]/g, "") // controles (incluido el NUL U+0000)
    .replace(/[^A-Za-z0-9._-]+/g, "_") // separadores de ruta y caracteres hostiles
    .replace(/\.{2,}/g, ".") // sin ".." como segmento
    .replace(/^\.+/, "") // ni nombres ocultos
    .replace(/[._-]+$/, "") // ni separadores colgando al final
  const stem = (cleaned || "comprobante").slice(0, Math.max(1, FILENAME_MAX - ext.length - 1))
  return `${stem}.${ext}`
}

export interface ProcessedReceiptFile {
  bytes: Uint8Array
  mime: string
  /** Mime de origen cuando el archivo se convirtió (HEIC→JPEG, strip EXIF); null si quedó igual. */
  convertedFrom: string | null
}

/**
 * Punto de extensión del pipeline de archivos. PDF: passthrough byte a byte. Imágenes
 * (jpeg/png/webp/heic/heif): normalización en receipt-image.ts — HEIC/HEIF se convierten
 * a JPEG (2560 px, q82) y el resto se re-encoda aplicando orientación y sin EXIF/GPS.
 * El import es dinámico para no cargar sharp/heic-decode en los procesos que nunca
 * procesan imágenes (bundle y memoria solo se pagan cuando toca).
 */
export async function processReceiptFile(bytes: Uint8Array, mime: string): Promise<ProcessedReceiptFile> {
  if (mime === "application/pdf") return { bytes, mime, convertedFrom: null }
  const { normalizeImage } = await import("@/lib/receipt-image")
  const out = await normalizeImage(bytes, mime)
  return { bytes: out.bytes, mime: out.mime, convertedFrom: out.mime === mime ? null : mime }
}
