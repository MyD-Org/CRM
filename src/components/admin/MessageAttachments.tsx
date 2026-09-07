"use client"

import { useState } from "react"
import { FileText, Download, ExternalLink, FileQuestion } from "lucide-react"
import type { MessageAttachment } from "@/lib/inbox-api"
export { stripAttachmentMarker } from "@/lib/message-text"

// ai-api firma una URL nueva en CADA request, y el thread poolea cada 5s. Si esa URL entra
// derecho como `src`, React se lo cambia al elemento en cada poll y el navegador reinicia
// la carga: el audio se corta a la mitad como si hubiera terminado (con el archivo entero
// ya buffereado, sin ningún error). Congelamos la primera URL que llega y no la volvemos a
// tocar mientras el componente siga montado.
//
// El único caso en que sí se actualiza es cuando arrancó en null (storage caído o sin
// configurar) y después apareció: ahí no hay nada que interrumpir.
function useStableUrl(url: string | null): string | null {
  const [frozen, setFrozen] = useState(url)
  if (frozen === null && url !== null) setFrozen(url)
  return frozen
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// DOS estados distintos, y confundirlos desinforma al operador:
//
//  - "no disponible": no hay URL. El archivo no está y no hay nada que abrir.
//  - "no se pudo cargar": la URL existe pero el navegador no la pudo mostrar. Puede ser
//    que el archivo haya expirado (el bucket borra los pesados a los 30 días) o que este
//    navegador no soporte el códec — desde acá no se distingue. Decir "ya no disponible"
//    sería afirmar algo que no sabemos, así que se ofrece abrirlo aparte.
function Unavailable({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-xs"
      style={{ background: "var(--card)", border: "1px dashed var(--border)", color: "var(--ink-faint)" }}
    >
      <FileQuestion size={14} />
      <span>{label}</span>
    </div>
  )
}

function CouldNotLoad({ url, label }: { url: string; label: string }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-xs"
      style={{ background: "var(--card)", border: "1px dashed var(--border)", color: "var(--ink-soft)" }}
    >
      <span>{label}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 shrink-0"
        style={{ color: "var(--blue)" }}
      >
        Abrir archivo <ExternalLink size={11} />
      </a>
    </div>
  )
}

function ImageAttachment({ att }: { att: MessageAttachment }) {
  const [broken, setBroken] = useState(false)
  const src = useStableUrl(att.url)
  if (!src) return <Unavailable label="Imagen no disponible" />
  if (broken) return <CouldNotLoad url={src} label="No se pudo mostrar la imagen." />
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element -- el src es una URL firmada
          de otro origen y de vida corta: el optimizador de Next no puede procesarla. */}
      <img
        src={src}
        alt="Imagen enviada por el cliente"
        onError={() => setBroken(true)}
        className="rounded-[var(--radius)] max-h-64 w-auto object-cover cursor-zoom-in"
        style={{ border: "1px solid var(--border)" }}
      />
    </a>
  )
}

function AudioAttachment({ att }: { att: MessageAttachment }) {
  const [broken, setBroken] = useState(false)
  const src = useStableUrl(att.url)
  if (!src) return <Unavailable label="Audio no disponible" />
  if (broken) return <CouldNotLoad url={src} label="No se pudo reproducir el audio acá." />
  // Ancho FIJO, no w-full: el contenedor de la burbuja se dimensiona según su contenido
  // (lleva max-w en %), así que un hijo al 100% es una referencia circular y el reproductor
  // colapsa a un botón de ~40px con tres puntitos. max-w-full lo achica en pantallas
  // angostas. Mismo motivo en el video.
  return (
    <audio
      controls
      preload="metadata"
      src={src}
      onError={() => setBroken(true)}
      className="w-[280px] max-w-full"
    />
  )
}

function VideoAttachment({ att }: { att: MessageAttachment }) {
  const [broken, setBroken] = useState(false)
  const src = useStableUrl(att.url)
  if (!src) return <Unavailable label="Video no disponible" />
  if (broken) return <CouldNotLoad url={src} label="No se pudo reproducir el video acá." />
  return (
    <video
      controls
      preload="metadata"
      src={src}
      onError={() => setBroken(true)}
      className="rounded-[var(--radius)] max-h-64 w-[320px] max-w-full"
      style={{ border: "1px solid var(--border)" }}
    />
  )
}

function FileAttachment({ att }: { att: MessageAttachment }) {
  if (!att.url) return <Unavailable label="Archivo no disponible" />
  return (
    <a
      href={att.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] text-xs transition-colors"
      style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--ink)" }}
    >
      <FileText size={14} style={{ color: "var(--ink-soft)" }} />
      <span className="truncate max-w-[180px]">{att.filename ?? "Archivo"}</span>
      <span style={{ color: "var(--ink-faint)" }}>{humanSize(att.size_bytes)}</span>
      <Download size={12} style={{ color: "var(--ink-faint)" }} />
    </a>
  )
}

export function MessageAttachments({ attachments }: { attachments?: MessageAttachment[] }) {
  if (!attachments?.length) return null
  return (
    <div className="flex flex-col gap-1.5 mb-1.5">
      {attachments.map((att) => {
        // Por mime y no por kind: el kind viene del type de WhatsApp, pero un 'document'
        // puede ser perfectamente una foto que el cliente mandó como archivo, y el operador
        // espera verla, no bajarla.
        const mime = att.mime.split(";")[0].trim()
        // La key NUNCA puede depender de la url: cambia en cada poll y remontaría
        // el reproductor. `id` es estable para el mismo archivo.
        const key = att.id
        if (mime.startsWith("image/")) return <ImageAttachment key={key} att={att} />
        if (mime.startsWith("audio/")) return <AudioAttachment key={key} att={att} />
        if (mime.startsWith("video/")) return <VideoAttachment key={key} att={att} />
        return <FileAttachment key={key} att={att} />
      })}
    </div>
  )
}
