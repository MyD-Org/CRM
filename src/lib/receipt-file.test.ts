import { describe, it, expect } from "vitest"
import { sniffMime, extFor, sanitizeFilename, processReceiptFile } from "@/lib/receipt-file"

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 1])
const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

function webp(brand: string): Uint8Array {
  const bytes = new Uint8Array(16)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set(Array.from(brand, (c) => c.charCodeAt(0)), 12)
  return bytes
}

function heic(brand: string): Uint8Array {
  const bytes = new Uint8Array(16)
  bytes.set([0, 0, 0, 0x18], 0) // tamaño de la caja
  bytes.set(Array.from("ftyp", (c) => c.charCodeAt(0)), 4)
  bytes.set(Array.from(brand, (c) => c.charCodeAt(0)), 8)
  return bytes
}

describe("sniffMime", () => {
  it("detecta los 5 tipos por magic bytes", () => {
    expect(sniffMime(PDF_HEADER)).toBe("application/pdf")
    expect(sniffMime(JPEG_HEADER)).toBe("image/jpeg")
    expect(sniffMime(PNG_HEADER)).toBe("image/png")
    expect(sniffMime(webp("VP8 "))).toBe("image/webp")
    expect(sniffMime(heic("heic"))).toBe("image/heic")
    expect(sniffMime(heic("mif1"))).toBe("image/heif")
  })

  it("detecta PDF con basura previa dentro del primer KB", () => {
    const withPrefix = new Uint8Array(100)
    withPrefix.set([0x25, 0x50, 0x44, 0x46, 0x2d], 20)
    expect(sniffMime(withPrefix)).toBe("application/pdf")
  })

  it("detecta brands HEIC/HEIF válidos", () => {
    for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis"]) {
      expect(sniffMime(heic(brand))).toBe("image/heic")
    }
    for (const brand of ["mif1", "msf1"]) {
      expect(sniffMime(heic(brand))).toBe("image/heif")
    }
  })

  it("rechaza SVG, HTML, ZIP y vacío (⇒ null)", () => {
    expect(sniffMime(new Uint8Array(0))).toBeNull()
    expect(sniffMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull()
    expect(sniffMime(new TextEncoder().encode("<!DOCTYPE html><html></html>"))).toBeNull()
    expect(sniffMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull() // ZIP/Office
  })

  it("un SVG declarado como png sniffea null (no confía en el declarado)", () => {
    const declaredPng = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
    expect(sniffMime(declaredPng)).toBeNull()
  })
})

describe("extFor", () => {
  it("extensión según el mime real", () => {
    expect(extFor("application/pdf")).toBe("pdf")
    expect(extFor("image/jpeg")).toBe("jpg")
    expect(extFor("image/png")).toBe("png")
    expect(extFor("image/webp")).toBe("webp")
    expect(extFor("application/octet-stream")).toBe("bin")
  })
})

describe("sanitizeFilename", () => {
  it("nombre hostil: sin traversal, NUL, <>, '..' como segmento, ≤80, ext del mime real", () => {
    const nul = String.fromCharCode(0) // el NUL se construye así, no con escape literal
    const out = sanitizeFilename(`../../Pagó <b>junio</b>.PNG.exe${nul}`, "image/jpeg")
    expect(out.length).toBeLessThanOrEqual(80)
    expect(out.endsWith(".jpg")).toBe(true)
    expect(out).not.toContain("/")
    expect(out).not.toContain("\\")
    expect(out).not.toContain("<")
    expect(out).not.toContain(">")
    expect(out).not.toContain(nul)
    expect(out).not.toMatch(/\.\./)
  })

  it("saca diacríticos y separadores", () => {
    expect(sanitizeFilename("comprobánté/junio:final?", "application/pdf")).toBe("comprobante_junio_final.pdf")
  })

  it("recorta a 80 caracteres conservando la extensión", () => {
    const out = sanitizeFilename("a".repeat(200), "image/png")
    expect(out.length).toBe(80)
    expect(out.endsWith(".png")).toBe(true)
  })

  it("nombre que queda vacío ⇒ 'comprobante.<ext>'", () => {
    expect(sanitizeFilename("☃★", "application/pdf")).toBe("comprobante.pdf")
  })
})

describe("processReceiptFile", () => {
  it("passthrough byte a byte para PDF (sin tocar el buffer)", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const out = await processReceiptFile(bytes, "application/pdf")
    expect(out).toEqual({ bytes, mime: "application/pdf", convertedFrom: null })
    expect(out.bytes).toBe(bytes) // mismo objeto: sin copia ni re-encode
  })

  // La conversión real de imágenes (HEIC⇒JPEG, strip EXIF, topes) se testea en
  // receipt-image.test.ts: processReceiptFile es solo el dispatcher hacia normalizeImage.
})
