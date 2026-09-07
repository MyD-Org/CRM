import { describe, it, expect } from "vitest"
import { stripAttachmentMarker, previewText } from "./message-text"

// La marca entre corchetes existe para el BOT (que no puede ver el archivo). Al operador,
// que tiene el adjunto a la vista, solo le sirve el caption. Pero es texto del mensaje, no
// un campo aparte: hay que sacarla sin comerse nada que haya escrito la persona.
describe("stripAttachmentMarker", () => {
  it("saca la marca y deja el caption", () => {
    expect(stripAttachmentMarker("[El cliente envió una imagen]\n¿tenés este modelo?", true))
      .toBe("¿tenés este modelo?")
  })

  it("sin caption queda vacío, para no dibujar una burbuja hueca", () => {
    expect(stripAttachmentMarker("[El cliente envió un mensaje de audio]", true)).toBe("")
  })

  it("conserva un caption de varias líneas", () => {
    expect(stripAttachmentMarker("[El cliente envió una imagen]\nhola\nchau", true)).toBe("hola\nchau")
  })

  // Sin adjunto no hay nada que limpiar, aunque el texto parezca una marca: eso lo
  // escribió el cliente y tiene que verse tal cual.
  it("no toca el texto cuando no hay adjuntos", () => {
    expect(stripAttachmentMarker("[esto lo escribí yo]", false)).toBe("[esto lo escribí yo]")
  })

  // El caso que más importa: un cliente puede escribir corchetes. Se acota a que la primera
  // línea sea EXACTAMENTE un corchete abierto y cerrado, que es lo que genera ai-api.
  it("no borra una primera línea que no es una marca completa", () => {
    expect(stripAttachmentMarker("mirá [esto] por favor", true)).toBe("mirá [esto] por favor")
    expect(stripAttachmentMarker("[incompleto\nsegunda", true)).toBe("[incompleto\nsegunda")
  })

  it("tolera texto vacío", () => {
    expect(stripAttachmentMarker("", true)).toBe("")
  })
})

// La lista de conversaciones NO sabe si hubo adjunto: solo tiene el string del último
// mensaje. Sin traducir, el operador leía "[El cliente envió un mensaje de audio]" crudo.
describe("previewText", () => {
  it("traduce la marca a ícono + etiqueta corta", () => {
    expect(previewText("[El cliente envió un mensaje de audio]")).toBe("🎤 Audio")
    expect(previewText("[El cliente envió una imagen]")).toBe("📷 Imagen")
    expect(previewText("[El cliente envió una ubicación]")).toBe("📍 Ubicación")
  })

  // Con caption, el caption dice más que la etiqueta: se prefiere ese.
  it("con caption muestra el caption detrás del ícono", () => {
    expect(previewText("[El cliente envió una imagen]\n¿tenés este repuesto?"))
      .toBe("📷 ¿tenés este repuesto?")
  })

  it("también traduce lo que mandó el equipo desde el celu", () => {
    expect(previewText("[El equipo envió una imagen]")).toBe("📷 Imagen")
  })

  it("un mensaje normal pasa intacto", () => {
    expect(previewText("hola, ¿tienen stock?")).toBe("hola, ¿tienen stock?")
    expect(previewText("mirá [esto]")).toBe("mirá [esto]")
  })

  // Si mañana ai-api agrega un tipo nuevo, el preview no puede quedar en blanco.
  it("una marca desconocida cae al texto de la marca", () => {
    expect(previewText("[El cliente envió una cosa rara]")).toBe("El cliente envió una cosa rara")
  })
})
