import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { deliverReceiptEmail } from "@/lib/receipt-delivery"
import { getAdmin, toAdminDto } from "@/lib/payment-receipts"
import { getR2 } from "@/lib/r2"
import { requestOrigin } from "@/lib/request-origin"
import { getTenantByIdFromDb } from "@/lib/tenants"

// POST /api/admin/comprobantes/[id]/resend-email — reenvío manual del mail de aviso.
// Mismo camino que el envío del confirm (D4): lease de 60 s + idempotencyKey de Resend,
// leyendo el adjunto desde R2 si entra en 10 MB. NO toca el `status` del comprobante:
// solo actualiza el bloque email_* de la fila.

export const maxDuration = 60

const NO_STORE = { "Cache-Control": "private, no-store" }

type IdParams = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  const row = await getAdmin(guard.tenantId, id)
  if (!row) return adminNotFoundResponse()

  const config = await getTenantByIdFromDb(guard.tenantId)
  if (!config) {
    console.error(`[admin/comprobantes] sin config para tenant "${guard.tenantId}" en resend`)
    return Response.json(
      { error: "No pudimos preparar el envío, intentá de nuevo en unos minutos", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    )
  }

  // Puede ser null: deliverReceiptEmail solo lo necesita si va a adjuntar (≤10 MB) y en
  // ese caso devuelve storage_unavailable (503) sin tocar email_status.
  const r2 = getR2()
  const origin = requestOrigin(req)
  const result = await deliverReceiptEmail({ tenant: config, receiptId: id, origin }, { r2 })

  switch (result.status) {
    case "sent": {
      const fresh = await getAdmin(guard.tenantId, id)
      return Response.json({ email: toAdminDto(fresh ?? row, new Date()).email }, { headers: NO_STORE })
    }
    case "in_progress":
      return Response.json(
        { error: "Ya hay un envío de este mail en curso, probá de nuevo en unos segundos", code: "email_in_progress" },
        { status: 409, headers: NO_STORE },
      )
    case "skipped":
      return Response.json({ error: result.reason, code: "email_skipped" }, { status: 409, headers: NO_STORE })
    case "failed":
      return Response.json(
        { error: result.error, code: "email_failed" },
        { status: 502, headers: NO_STORE },
      )
    case "storage_unavailable":
      return Response.json(
        { error: "El almacenamiento de comprobantes no está disponible, intentá de nuevo más tarde", code: "storage_unavailable" },
        { status: 503, headers: NO_STORE },
      )
  }
}
