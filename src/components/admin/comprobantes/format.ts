// Formateo de los campos del DTO admin de comprobantes para la tabla y el diálogo.

const CURRENCY = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
})

/** "12345.67" (string decimal del DTO) → "$ 123.456,70". Solo para MOSTRAR: nunca se persiste. */
export function fmtMonto(amount: string): string {
  return CURRENCY.format(Number(amount))
}

/** "2026-09-13" → "13/09/2026" (viene como fecha de calendario, sin zona horaria). */
export function fmtFecha(ymd: string): string {
  const [y, m, d] = ymd.split("-")
  return y && m && d ? `${d}/${m}/${y}` : ymd
}

const FECHA_HORA = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Argentina/Buenos_Aires",
})

/** ISO (submittedAt, loadedAt…) → "13/09/2026 14:32" hora Argentina. */
export function fmtFechaHora(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return FECHA_HORA.format(d)
}

export function fmtTamano(bytes: number): string {
  if (bytes <= 0) return "—"
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`
}

export const METHOD_LABELS: Record<string, string> = {
  transferencia: "Transferencia",
  cheque: "Cheque",
  efectivo: "Efectivo",
  otro: "Otro",
}

export function methodLabel(method: string, methodOther: string | null): string {
  if (method === "otro") return methodOther ? `Otro: ${methodOther}` : "Otro"
  return METHOD_LABELS[method] ?? method
}

export const MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WebP",
}

export function fileLabel(mime: string, convertedFrom: string | null): string {
  const base = MIME_LABELS[mime] ?? mime
  return convertedFrom ? `${base} (convertido de ${MIME_LABELS[convertedFrom] ?? convertedFrom})` : base
}
