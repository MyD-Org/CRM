// Los mensajes con adjunto llegan con una marca entre corchetes al principio del texto
// ("[El cliente envió una imagen]"). Esa marca existe para el BOT: es la única forma que
// tiene de enterarse de que llegó un archivo que no puede leer. Al operador no le sirve
// —tiene el archivo a la vista— así que en el CRM se saca o se traduce a algo legible.
//
// Se detecta con un formato estricto: la PRIMERA línea, completa, entre corchetes. Un
// cliente puede escribir corchetes y ese texto tiene que verse tal cual.
const MARKER = /^\[(.+)\]$/

function splitMarker(text: string): { marker: string | null; rest: string } {
  const [first, ...rest] = text.split("\n")
  const m = first.trim().match(MARKER)
  return m ? { marker: m[1], rest: rest.join("\n").trim() } : { marker: null, rest: text }
}

/**
 * Saca la marca del cuerpo de la burbuja, dejando solo el caption (que sí lo escribió la
 * persona). Solo actúa si el mensaje realmente trae adjuntos: sin eso, un texto entre
 * corchetes es texto del cliente y se muestra intacto.
 */
export function stripAttachmentMarker(text: string, hasAttachments: boolean): string {
  if (!hasAttachments) return text
  return splitMarker(text).rest
}

const PREVIEW_ICONS: Array<[RegExp, string, string]> = [
  [/audio/i, "🎤", "Audio"],
  [/imagen/i, "📷", "Imagen"],
  [/video/i, "🎬", "Video"],
  [/archivo/i, "📎", "Archivo"],
  [/sticker/i, "🏷️", "Sticker"],
  [/ubicaci/i, "📍", "Ubicación"],
  [/contacto/i, "👤", "Contacto"],
  [/reacci/i, "💬", "Reacción"],
]

/**
 * Texto para la LISTA de conversaciones, que solo tiene el string del último mensaje (no
 * sabe si hubo adjunto). Traduce la marca a un ícono + etiqueta corta, y si venía con
 * caption muestra el caption, que es más informativo que "Imagen".
 *
 * Sin marca devuelve el texto tal cual, así que es seguro pasarle cualquier mensaje.
 */
export function previewText(text: string): string {
  const { marker, rest } = splitMarker(text)
  if (!marker) return text
  const hit = PREVIEW_ICONS.find(([re]) => re.test(marker))
  if (!hit) return rest || marker
  const [, icon, label] = hit
  return rest ? `${icon} ${rest}` : `${icon} ${label}`
}
