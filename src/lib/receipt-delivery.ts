// Envío del mail de aviso de comprobante. ÚNICO camino para el envío inicial (confirm) y el
// reenvío del admin (D4): lease propio de 60 s (claimEmailAttempt) + idempotencyKey de Resend
// (`payment-receipt/{id}/{attempt}`). El resultado se persiste en email_* y se devuelve
// tipado para que la ruta decida su status HTTP — el confirm ignora el resultado por completo.

import { sendEmail } from "@/lib/email"
import { ATTACH_MAX_BYTES, buildReceiptEmail, formatFromAddress } from "@/lib/receipt-email"
import { extFor } from "@/lib/receipt-file"
import * as repo from "@/lib/payment-receipts"
import type { R2Client } from "@/lib/r2"
import type { TenantConfig } from "@/lib/tenants"

export type DeliveryResult =
  | { status: "sent" }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string }
  | { status: "in_progress" }
  /** Hacía falta leer el archivo (adjunto del reenvío) y no hay cliente R2: la ruta responde
   *  503 storage_unavailable y el admin reintenta. No se toca email_status. */
  | { status: "storage_unavailable" }

export interface DeliverReceiptEmailInput {
  tenant: TenantConfig
  receiptId: string
  /** Origen absoluto del request (https://{host}): el link del mail es `/admin/comprobantes?id=…`. */
  origin: string
  /** Bytes ya verificados en memoria (confirm). Si falta y el archivo entra en 10 MB, se lee
   *  desde R2 (reenvío del admin). */
  buffer?: Uint8Array
  /** B: comprobante anterior del mismo cliente con estos mismos bytes (aviso, no bloquea). */
  duplicateOf?: { id: string; submittedAt: Date } | null
}

export interface ReceiptDeliveryDeps {
  r2: R2Client | null
  now?: () => Date
}

// Los tags de Resend solo aceptan [A-Za-z0-9_-]: el id de tenant ya matchea, pero se sanea
// igual (defensa barata contra un tenant con caracteres raros).
function tagValue(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "")
}

function looksLikeEmail(s: string | null): s is string {
  return typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
}

export async function deliverReceiptEmail(
  input: DeliverReceiptEmailInput,
  deps: ReceiptDeliveryDeps,
): Promise<DeliveryResult> {
  const { tenant, receiptId, origin, buffer, duplicateOf } = input
  const now = deps.now ?? (() => new Date())

  // 1. Lease: sin fila ⇒ hay un envío en curso (o la fila no está publicada).
  const attempt = await repo.claimEmailAttempt(tenant.id, receiptId, now())
  if (attempt === null) return { status: "in_progress" }

  const skipped = async (reason: string): Promise<DeliveryResult> => {
    await repo.recordEmailResult(tenant.id, receiptId, { status: "skipped", reason }, now())
    return { status: "skipped", reason }
  }

  // 2. Configuración faltante ⇒ skipped (no se cae a tenant.resendFrom: remitente de plataforma).
  const to = tenant.receiptsEmail
  if (!to) return skipped("mail destino no configurado")
  const fromAddress = process.env.RECEIPTS_EMAIL_FROM ?? ""
  if (!fromAddress) return skipped("remitente no configurado")

  const row = await repo.getAdmin(tenant.id, receiptId)
  if (!row || !row.fileKey || !row.fileMime || !row.fileSize || !row.submittedAt) {
    // El claim garantizaba pending/loaded con archivo publicado; llegar acá es una condición
    // imposible, pero no se cuelga por las dudas.
    await repo.recordEmailResult(tenant.id, receiptId, { status: "failed", error: "comprobante no disponible" }, now())
    return { status: "failed", error: "comprobante no disponible" }
  }

  // 3. Adjunto: solo si entra en 10 MB. Sin buffer (reenvío) se lee el archivo publicado de R2.
  const id8 = row.id.slice(0, 8)
  const filename = `comprobante-${row.paidOn}-${id8}.${extFor(row.fileMime)}`
  let attachment: { filename: string; content: Buffer; contentType: string } | undefined
  if (buffer) {
    if (buffer.length <= ATTACH_MAX_BYTES) {
      attachment = { filename, content: Buffer.from(buffer), contentType: row.fileMime }
    }
  } else if (row.fileSize <= ATTACH_MAX_BYTES) {
    if (!deps.r2) return { status: "storage_unavailable" }
    const bytes = await deps.r2.getObject(row.fileKey, { maxBytes: ATTACH_MAX_BYTES })
    if (bytes === null) {
      await repo.recordEmailResult(tenant.id, receiptId, { status: "failed", error: "archivo no disponible en el almacenamiento" }, now())
      return { status: "failed", error: "archivo no disponible en el almacenamiento" }
    }
    attachment = { filename, content: Buffer.from(bytes), contentType: row.fileMime }
  }

  // 4. Build + send.
  const clientEmail = looksLikeEmail(row.clientEmail) ? row.clientEmail : null
  const email = buildReceiptEmail({
    tenantName: tenant.name,
    receipt: {
      id: row.id,
      razonsocial: row.razonsocial,
      cuit: row.cuit,
      codigocliente: row.codigocliente,
      amount: row.amount,
      paidOn: row.paidOn,
      method: row.method,
      methodOther: row.methodOther,
      notes: row.notes,
      fileMime: row.fileMime,
      fileSize: row.fileSize,
      submittedAt: row.submittedAt,
      convertedFrom: row.convertedFrom,
    },
    adminUrl: `${origin}/admin/comprobantes?id=${row.id}`,
    attachmentIncluded: attachment !== undefined,
    clientEmail,
    duplicateOf: duplicateOf ?? null,
  })

  try {
    const sent = await sendEmail(tenant, to, email.subject, email.html, email.text, {
      from: formatFromAddress(`${tenant.name} · Comprobantes`, fromAddress),
      replyTo: clientEmail ?? undefined,
      attachments: attachment ? [attachment] : undefined,
      tags: [
        { name: "type", value: "payment_receipt" },
        { name: "tenant", value: tagValue(tenant.id) },
      ],
      idempotencyKey: `payment-receipt/${row.id}/${attempt}`,
    })
    // Sin RESEND_API_KEY sendEmail hace dry-run y devuelve false ⇒ skipped, no failed.
    if (!sent) return skipped("servicio de correo no configurado")
    await repo.recordEmailResult(tenant.id, receiptId, { status: "sent" }, now())
    return { status: "sent" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await repo.recordEmailResult(tenant.id, receiptId, { status: "failed", error: message }, now())
    return { status: "failed", error: message }
  }
}
