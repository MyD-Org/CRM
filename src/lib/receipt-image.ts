// Conversión de imágenes de comprobantes (entrega C). HEIC/HEIF (fotos de iPhone que se
// cuelan por Mac/Files/AirDrop aunque el <input accept> pida JPG/PNG/PDF) se convierten a
// JPEG; JPEG/PNG/WebP se re-encoden para aplicar la orientación y quedar sin EXIF/GPS.
// Los PDF no pasan por acá (processReceiptFile los deja untouched).
//
// Tope duro de 50 MP ANTES de decodificar: un HEIC que declara 20000×20000 son ~1,6 GB de
// RGBA al decodificar (bomba de descompresión) ⇒ 415 sin gastar memoria. Todo corre bajo un
// semáforo por proceso (una conversión a la vez): el runtime fluido de Vercel ya usa memoria
// de sobra y dos HEIC de 48 MP concurrentes lo funden.

export const MAX_IMAGE_PIXELS = 50_000_000
export const IMAGE_MAX_WIDTH = 2560

export type ReceiptImageErrorCode = "image_too_large" | "processing_failed"

export class ReceiptImageError extends Error {
  constructor(readonly code: ReceiptImageErrorCode) {
    super(code === "image_too_large" ? "La imagen es demasiado grande" : "No pudimos procesar la imagen")
    this.name = "ReceiptImageError"
  }
}

export interface NormalizedImage {
  bytes: Uint8Array
  mime: string
}

// ── Semáforo por proceso ─────────────────────────────────────────────────────

let cadena: Promise<unknown> = Promise.resolve()

async function unaALaVez<T>(fn: () => Promise<T>): Promise<T> {
  const turno = cadena.then(fn, fn)
  // La cadena sigue aunque fn falle: un error no libera el semáforo para todos.
  cadena = turno.then(
    () => undefined,
    () => undefined,
  )
  return turno
}

// ── Dimensiones HEIC sin decodificar (caja `ispe`) ───────────────────────────
// heic-decode no expone dimensiones antes del decode; se lee la caja ISOBMFF `ispe`
// (ImageSpatialExtents) del primer item. Sin ispe no hay forma de garantizar el tope de
// 50 MP antes de decodificar ⇒ se rechaza (processing_failed) en vez de arriesgar la memoria.

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function tipo4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

interface Caja {
  tipo: string
  /** Payload completo de la caja (sin size ni type). */
  inicio: number
  fin: number
}

/** Itera cajas ISOBMFF en [inicio, fin). Las de tamaño 1 (largesize) se saltan: no aparecen
 *  en HEIC de iPhone y agregarían 8 bytes de header por caja. */
function* cajas(bytes: Uint8Array, inicio: number, fin: number): Generator<Caja> {
  let offset = inicio
  while (offset + 8 <= fin) {
    const size = u32(bytes, offset)
    const tipo = tipo4(bytes, offset + 4)
    if (size === 1 || (size !== 0 && size < 8)) return
    const payloadFin = size === 0 ? fin : Math.min(offset + size, fin)
    yield { tipo, inicio: offset + 8, fin: payloadFin }
    offset = payloadFin
  }
}

function leerIspe(bytes: Uint8Array, inicio: number, fin: number): { width: number; height: number } | null {
  // ispe es full box: 4 bytes version/flags + width u32 + height u32.
  if (fin - inicio < 12) return null
  return { width: u32(bytes, inicio + 4), height: u32(bytes, inicio + 8) }
}

export function heicDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    for (const top of cajas(bytes, 0, bytes.length)) {
      if (top.tipo !== "meta") continue
      // meta es full box: los children arrancan después de version/flags.
      for (const hijo of cajas(bytes, top.inicio + 4, top.fin)) {
        if (hijo.tipo !== "iprp") continue
        for (const prop of cajas(bytes, hijo.inicio, hijo.fin)) {
          if (prop.tipo !== "ipco") continue
          for (const entry of cajas(bytes, prop.inicio, prop.fin)) {
            if (entry.tipo === "ispe") return leerIspe(bytes, entry.inicio, entry.fin)
          }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// ── Normalización ────────────────────────────────────────────────────────────

async function heicAJpeg(bytes: Uint8Array): Promise<NormalizedImage> {
  const dims = heicDimensions(bytes)
  if (!dims || dims.width <= 0 || dims.height <= 0) throw new ReceiptImageError("processing_failed")
  if (dims.width * dims.height > MAX_IMAGE_PIXELS) throw new ReceiptImageError("image_too_large")

  let width: number
  let height: number
  let data: Uint8ClampedArray
  try {
    const heicDecode = (await import("heic-decode")).default
    // API real: decode({ buffer }) (objeto, no el buffer suelto — ver lib.js del paquete).
    ;({ width, height, data } = await heicDecode({ buffer: bytes }))
  } catch {
    throw new ReceiptImageError("processing_failed")
  }

  try {
    const sharp = (await import("sharp")).default
    const jpeg = await sharp(data, { raw: { width, height, channels: 4 } })
      .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()
    return { bytes: new Uint8Array(jpeg), mime: "image/jpeg" }
  } catch {
    throw new ReceiptImageError("processing_failed")
  }
}

async function reencodeSinExif(bytes: Uint8Array, mime: string): Promise<NormalizedImage> {
  const sharp = (await import("sharp")).default
  let meta: { width?: number; height?: number }
  try {
    // metadata() parsea solo los headers: es el chequeo de 50 MP barato, antes de decodificar.
    meta = await sharp(bytes).metadata()
  } catch {
    throw new ReceiptImageError("processing_failed")
  }
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_IMAGE_PIXELS) {
    throw new ReceiptImageError("image_too_large")
  }
  try {
    // rotate() aplica la orientación EXIF a los píxeles; sin withMetadata() el resultado
    // queda sin EXIF/GPS. No se redimensionan (spec: MAY; solo HEIC tiene tope de ancho).
    const base = sharp(bytes).rotate()
    const salida =
      mime === "image/png"
        ? base.png()
        : mime === "image/webp"
          ? base.webp({ quality: 82 })
          : base.jpeg({ quality: 82, mozjpeg: true })
    const buf = await salida.toBuffer()
    return { bytes: new Uint8Array(buf), mime }
  } catch {
    throw new ReceiptImageError("processing_failed")
  }
}

/**
 * Normaliza una imagen de comprobante. HEIC/HEIF ⇒ JPEG (resize a 2560 sin agrandar, q82);
 * JPEG/PNG/WebP ⇒ re-encode en su formato con orientación aplicada y sin EXIF/GPS.
 * Errores tipados: `image_too_large` (415) o `processing_failed` (422).
 */
export async function normalizeImage(bytes: Uint8Array, mime: string): Promise<NormalizedImage> {
  if (mime === "image/heic" || mime === "image/heif") return unaALaVez(() => heicAJpeg(bytes))
  return unaALaVez(() => reencodeSinExif(bytes, mime))
}
