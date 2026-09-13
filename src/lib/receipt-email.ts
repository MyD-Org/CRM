// Builder puro del mail de aviso de comprobante (patrón otp-email.ts). Toda la confianza
// es paranoica acá: los datos del cliente vienen del portal y el mail se renderiza en
// clientes que ejecutan HTML — todo dato pasa por escapeHtml y el subject sale en una
// sola línea. El adjunto (o su ausencia por tamaño) se decide afuera y se informa acá.

/** Tope de adjunto: 10 MiB. A partir de +1 byte el mail va con link en vez de archivo. */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024 // 10485760

/** Prefijo fijo del asunto (spec: exacto, sin CR/LF). */
export const RECEIPT_EMAIL_SUBJECT_PREFIX = "[Comprobante de pago]"

const SUBJECT_MAX = 200
const FROM_DISPLAY_NAME_MAX = 64
const AR_TZ = "America/Argentina/Buenos_Aires"

/** Escape HTML completo (& < > " ') para todo dato que viene del cliente o del tenant. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** CR/LF y controles ⇒ espacio (defensa contra header injection en el subject). */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * Display name + dirección para el header From. Saca comillas y ángulos del nombre
 * (romperían el formato `"Nombre" <mail>`), recorta a 64.
 */
export function formatFromAddress(displayName: string, address: string): string {
  const name = displayName.replace(/["<>\r\n]/g, "").trim().slice(0, FROM_DISPLAY_NAME_MAX)
  return `"${name}" <${address}>`
}

function formatAmountAr(amount: string): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(amount))
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString("es-AR", { maximumFractionDigits: 1 })} MB`
}

/** "2026-09-01" → "01/09/2026". */
function formatDate(isoDate: string): string {
  const [y = "", m = "", d = ""] = isoDate.split("-")
  return `${d}/${m}/${y}`
}

/** Fecha+hora Argentina del momento en que se informó el comprobante. */
function formatSubmittedAt(d: Date): string {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: AR_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`
}

const METHOD_LABELS: Record<string, string> = {
  transferencia: "Transferencia",
  cheque: "Cheque",
  efectivo: "Efectivo",
  otro: "Otro",
}

export interface ReceiptEmailInput {
  tenantName: string
  receipt: {
    id: string
    razonsocial: string
    cuit: string
    codigocliente: string
    /** Decimal string ("150000.50"), no parseFloat para guardar — esto es solo formato. */
    amount: string
    /** "YYYY-MM-DD" (paid_on). */
    paidOn: string
    method: string
    methodOther?: string | null
    notes?: string | null
    fileMime: string
    fileSize: number
    submittedAt: Date
    convertedFrom?: string | null
  }
  /** Link absoluto al backoffice: https://{host}/admin/comprobantes?id={id}. */
  adminUrl: string
  /** true si el archivo (≤ ATTACH_MAX_BYTES) va adjunto. */
  attachmentIncluded: boolean
  /** Email del cliente (replyTo). Solo con esto el pie invita a responderle. */
  clientEmail?: string | null
  /** B: comprobante anterior del mismo cliente con los mismos bytes (aviso, no bloquea). */
  duplicateOf?: { id: string; submittedAt: Date } | null
}

export function buildReceiptEmail(input: ReceiptEmailInput): { subject: string; html: string; text: string } {
  const { receipt: r, tenantName } = input
  const e = escapeHtml

  const methodLabel =
    r.method === "otro" && r.methodOther
      ? `Otro (${r.methodOther})`
      : (METHOD_LABELS[r.method] ?? r.method)

  const subject = `${RECEIPT_EMAIL_SUBJECT_PREFIX} ${oneLine(r.razonsocial)} — ${oneLine(formatAmountAr(r.amount))} — ${formatDate(r.paidOn)}`.slice(0, SUBJECT_MAX)

  const sizeNote = input.attachmentIncluded
    ? "Va adjunto."
    : `El archivo pesa ${formatMb(r.fileSize)} y no se adjunta: abrilo desde el backoffice.`
  const dupNote = input.duplicateOf
    ? `Posible duplicado de un comprobante del ${formatSubmittedAt(input.duplicateOf.submittedAt)} (mismo archivo, ya informado).`
    : ""
  const convertedNote = r.convertedFrom ? ` (convertido de ${e(r.convertedFrom)})` : ""
  const archivo = `${e(r.fileMime)} · ${formatMb(r.fileSize)}${convertedNote}`
  const replyNote = input.clientEmail
    ? `<p style="margin:16px 0 0;padding-top:16px;border-top:1px solid #eef1f5">Respondé este mail para escribirle al cliente.</p>`
    : ""
  const notesRow = r.notes
    ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Notas</td><td style="padding:6px 0">${e(r.notes)}</td></tr>`
    : ""

  const html = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef1f5;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:440px;background:#ffffff;border-radius:12px;border-top:3px solid #1f8cff">
      <tr><td style="padding:28px 32px 0">
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280">${e(tenantName)}</div>
      </td></tr>
      <tr><td style="padding:20px 32px 0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#111827">
        <p style="margin:0 0 16px;font-size:18px;font-weight:700">Comprobante de pago recibido</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;width:130px">Cliente</td><td style="padding:6px 0">${e(r.razonsocial)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">CUIT</td><td style="padding:6px 0">${e(r.cuit)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Código</td><td style="padding:6px 0">${e(r.codigocliente)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Monto</td><td style="padding:6px 0">${e(formatAmountAr(r.amount))}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Fecha del pago</td><td style="padding:6px 0">${formatDate(r.paidOn)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Medio</td><td style="padding:6px 0">${e(methodLabel)}</td></tr>
          ${notesRow}
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Informado el</td><td style="padding:6px 0">${formatSubmittedAt(r.submittedAt)}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Archivo</td><td style="padding:6px 0">${archivo}</td></tr>
        </table>
        <p style="margin:16px 0 0">${sizeNote}</p>
        ${dupNote ? `<p style="margin:8px 0 0;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:13px">${e(dupNote)}</p>` : ""}
      </td></tr>
      <tr><td style="padding:20px 32px 28px">
        <a href="${e(input.adminUrl)}" style="display:inline-block;background:#1f8cff;color:#ffffff;text-decoration:none;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px">Ver en el backoffice</a>
      </td></tr>
      <tr><td style="padding:0 32px 28px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12px;line-height:1.55;color:#9ca3af">
        <p style="margin:0">Enviado automáticamente desde el portal de clientes de ${e(tenantName)}.</p>
        ${replyNote}
      </td></tr>
    </table>
  </td></tr>
</table>`

  const text = [
    `Comprobante de pago recibido (${tenantName})`,
    ``,
    `Cliente: ${r.razonsocial}`,
    `CUIT: ${r.cuit}`,
    `Código: ${r.codigocliente}`,
    `Monto: ${formatAmountAr(r.amount)}`,
    `Fecha del pago: ${formatDate(r.paidOn)}`,
    `Medio: ${methodLabel}`,
    ...(r.notes ? [`Notas: ${r.notes}`] : []),
    `Informado el: ${formatSubmittedAt(r.submittedAt)}`,
    `Archivo: ${r.fileMime} · ${formatMb(r.fileSize)}${r.convertedFrom ? ` (convertido de ${r.convertedFrom})` : ""}`,
    ``,
    sizeNote.replace(/<[^>]+>/g, ""),
    ...(dupNote ? [dupNote] : []),
    ``,
    `Ver en el backoffice: ${input.adminUrl}`,
    ``,
    `Enviado automáticamente desde el portal de clientes de ${tenantName}.` +
      (input.clientEmail ? " Respondé este mail para escribirle al cliente." : ""),
  ].join("\n")

  return { subject, html, text }
}
