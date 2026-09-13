import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import decode from "heic-decode"
import {
  normalizeImage,
  heicDimensions,
  ReceiptImageError,
  MAX_IMAGE_PIXELS,
  IMAGE_MAX_WIDTH,
} from "@/lib/receipt-image"
import { processReceiptFile, sniffMime } from "@/lib/receipt-file"

// Tests de la conversión de imágenes (entrega C, TH #18). El fixture HEIC es sintético
// (color liso generado por nosotros con sips, sin EXIF ni datos personales). El decoder se
// espía para el tope de 50 MP: tiene que rechazar ANTES de decodificar.

vi.mock("heic-decode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("heic-decode")>()
  return { default: vi.fn((input: { buffer: Uint8Array }) => actual.default(input)) }
})

const FIXTURE_HEIC = new Uint8Array(readFileSync(join(process.cwd(), "test/fixtures/receipts/solid.heic")))

/** Arma un HEIC mínimo con `ftyp heic` + meta/iprp/ipco/ispe de w×h (sin píxeles). */
function heicConIspe(width: number, height: number): Uint8Array {
  const caja = (tipo: string, payload: number[]): number[] => {
    const size = 8 + payload.length
    return [size >>> 24, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...tipo.split("").map((c) => c.charCodeAt(0)), ...payload]
  }
  const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  const ispe = caja("ispe", [...u32be(0), ...u32be(width), ...u32be(height)]) // full box: version/flags
  const ipco = caja("ipco", ispe)
  const iprp = caja("iprp", ipco)
  const meta = caja("meta", [...u32be(0), ...iprp]) // meta es full box
  const ftyp = caja("ftyp", [
    ...[..."heic"].map((c) => c.charCodeAt(0)),
    ...u32be(0),
    ...[..."mif1heic"].map((c) => c.charCodeAt(0)),
  ])
  return Uint8Array.from([...ftyp, ...meta])
}

/** Inyecta un segmento APP1 (EXIF con Orientation y GPS) justo después del SOI de un JPEG. */
function conExifGps(jpeg: Uint8Array, orientation: number): Uint8Array {
  // TIFF little-endian: IFD0 con Orientation + puntero a GPS IFD (lat/long racionales).
  const t: number[] = []
  const push16 = (...ns: number[]) => ns.forEach((n) => t.push(n & 0xff, (n >>> 8) & 0xff))
  const push32 = (...ns: number[]) => ns.forEach((n) => t.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff))
  t.push(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00) // "II" + 42 + offset IFD0
  // IFD0 en offset 8: 2 entradas + next. GPS IFD después: 8 + 2 + 2*12 + 4 = 38.
  const gpsIfdOffset = 38
  push16(2)
  push16(0x0112, 3, 1, 0); push32(orientation) // Orientation (SHORT, en los 2 bytes bajos)
  push16(0x8825, 4); push32(1, gpsIfdOffset) // GPSInfo (LONG) → offset GPS IFD
  push32(0) // sin más IFD
  // GPS IFD: 4 entradas + next + data de racionales (6 u32 = 24 bytes).
  const rationalesOffset = gpsIfdOffset + 2 + 4 * 12 + 4
  push16(4)
  push16(1, 2, 2); push32(0x0053_0000) // GPSLatitudeRef "S" (ASCII, inline "S\0")
  push16(2, 5, 3); push32(rationalesOffset) // GPSLatitude: 3 racionales
  push16(3, 2, 2); push32(0x0057_0000) // GPSLongitudeRef "W"
  push16(4, 5, 3); push32(rationalesOffset + 12) // GPSLongitude
  push32(0)
  push32(38, 1, 30, 1, 3000, 1) // 38°30'3000" — valores inventados
  push32(57, 1, 30, 1, 4000, 1)

  const app1Payload = [..."Exif\0\0".split("").map((c) => c.charCodeAt(0)), ...t]
  const app1Length = app1Payload.length + 2
  const app1 = [0xff, 0xe1, (app1Length >>> 8) & 0xff, app1Length & 0xff, ...app1Payload]
  return Uint8Array.from([0xff, 0xd8, ...app1, ...jpeg.slice(2)])
}

describe("normalizeImage", () => {
  it("HEIC sintético ⇒ JPEG, ≤2560 px, orientación/exif ausentes", async () => {
    const out = await normalizeImage(FIXTURE_HEIC, "image/heic")
    expect(out.mime).toBe("image/jpeg")
    const meta = await sharp(out.bytes).metadata()
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(240)
    expect(meta.width ?? 0).toBeLessThanOrEqual(IMAGE_MAX_WIDTH)
    expect(meta.exif).toBeUndefined()
  })

  it("PNG se re-encoda en su formato conservando dimensiones", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 100, height: 80, channels: 3, background: "#123456" } }).png().toBuffer())
    const out = await normalizeImage(png, "image/png")
    expect(out.mime).toBe("image/png")
    const meta = await sharp(out.bytes).metadata()
    expect([meta.width, meta.height]).toEqual([100, 80])
  })

  it("JPEG con EXIF Orientation=6 y GPS ⇒ orientación aplicada y sin EXIF/GPS", async () => {
    const base = new Uint8Array(await sharp({ create: { width: 400, height: 300, channels: 3, background: "#336699" } }).jpeg().toBuffer())
    const conGps = conExifGps(base, 6)
    const antes = await sharp(conGps).metadata()
    expect(antes.orientation).toBe(6) // sanity: el fixture trae orientación EXIF
    expect(antes.exif).toBeDefined()

    const out = await normalizeImage(conGps, "image/jpeg")
    const meta = await sharp(out.bytes).metadata()
    expect([meta.width, meta.height]).toEqual([300, 400]) // rotada
    expect(meta.orientation).toBeUndefined() // ya aplicada, no queda el tag
    expect(meta.exif).toBeUndefined() // strip: ni EXIF ni GPS
  })

  it("tope 50 MP: rechaza ANTES de decodificar (decoder no llamado)", async () => {
    vi.mocked(decode).mockClear()
    const bomba = heicConIspe(20000, 20000) // 400 MP declarados
    expect(heicDimensions(bomba)).toEqual({ width: 20000, height: 20000 })
    await expect(normalizeImage(bomba, "image/heic")).rejects.toMatchObject({ code: "image_too_large" })
    expect(decode).not.toHaveBeenCalled()
  })

  it("HEIC corrupto (sin ispe válido) ⇒ processing_failed", async () => {
    const corrupto = Uint8Array.from([...heicConIspe(10, 10).slice(0, 40), ...[1, 2, 3]])
    // Sin meta/iprp/ipco/ispe parseable: no se puede acotar la decodificación ⇒ 422.
    await expect(normalizeImage(corrupto, "image/heic")).rejects.toMatchObject({ code: "processing_failed" })
  })

  it("constantes de la spec: 50 MP y 2560 px", () => {
    expect(MAX_IMAGE_PIXELS).toBe(50_000_000)
    expect(IMAGE_MAX_WIDTH).toBe(2560)
  })
})

describe("processReceiptFile (integración con normalizeImage)", () => {
  it("PDF pasa byte a byte sin tocar", async () => {
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 1, 2, 3])
    const out = await processReceiptFile(bytes, "application/pdf")
    expect(out).toEqual({ bytes, mime: "application/pdf", convertedFrom: null })
    expect(out.bytes).toBe(bytes) // mismo objeto, sin copia ni re-encode
  })

  it("HEIC ⇒ JPEG con convertedFrom image/heic", async () => {
    expect(sniffMime(FIXTURE_HEIC)).toBe("image/heic")
    const out = await processReceiptFile(FIXTURE_HEIC, "image/heic")
    expect(out.mime).toBe("image/jpeg")
    expect(out.convertedFrom).toBe("image/heic")
    const meta = await sharp(out.bytes).metadata()
    expect(meta.format).toBe("jpeg")
  })

  it("JPEG queda JPEG con convertedFrom null", async () => {
    const base = new Uint8Array(await sharp({ create: { width: 50, height: 50, channels: 3, background: "#000000" } }).jpeg().toBuffer())
    const out = await processReceiptFile(base, "image/jpeg")
    expect(out.mime).toBe("image/jpeg")
    expect(out.convertedFrom).toBeNull()
  })
})
