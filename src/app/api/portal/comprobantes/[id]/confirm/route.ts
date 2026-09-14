import { requirePortalClient } from "@/lib/portal-route-guard"
import { confirmReceipt } from "@/lib/receipt-confirm"
import { deliverReceiptEmail } from "@/lib/receipt-delivery"
import * as repo from "@/lib/payment-receipts"
import { getR2 } from "@/lib/r2"
import { requestOrigin } from "@/lib/request-origin"

// POST /api/portal/comprobantes/[id]/confirm — verifica el archivo que el navegador subió
// directo a R2 (HEAD → range sniff → GET con tope → re-sniff → sha256 → PUT final →
// publish → delete tmp → mail) y publica el comprobante. Idempotente: un segundo confirm
// de una fila ya `pending`/`loaded` responde 200 sin repetir el mail.

export const maxDuration = 60
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePortalClient(req)
  if (!guard.ok) return guard.response

  const r2 = getR2()
  if (!r2) {
    return Response.json(
      { error: "El servicio de comprobantes no está disponible, intente nuevamente más tarde", code: "storage_unavailable" },
      { status: 503, headers: NO_STORE },
    )
  }

  try {
    const { id } = await params
    const origin = requestOrigin(req)

    const result = await confirmReceipt(
      {
        tenant: { id: guard.tenantId },
        session: { codigocliente: guard.session.codigocliente as string },
        id,
        origin,
      },
      {
        repo,
        r2,
        // El mail NUNCA cambia el resultado del confirm (try/catch adentro de confirmReceipt):
        // el buffer ya verificado se pasa para adjuntarlo sin releer de R2, y el duplicado
        // detectado (B) para el aviso "Posible duplicado…" del mail.
        deliver: (receiptId, buffer, duplicateOf) =>
          deliverReceiptEmail({ tenant: guard.config, receiptId, origin, buffer, duplicateOf }, { r2 }),
      },
    )

    if (result.ok) {
      return Response.json(
        {
          id,
          status: result.status,
          // B: el mismo archivo ya estaba informado (mismo sha256). No bloquea; avisa.
          ...(result.duplicateOf
            ? { duplicateOf: { id: result.duplicateOf.id, submittedAt: result.duplicateOf.submittedAt.toISOString() } }
            : {}),
        },
        { headers: NO_STORE },
      )
    }
    return Response.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE })
  } catch (err) {
    console.error("[portal/comprobantes] confirm error:", err)
    return Response.json(
      { error: "No pudimos procesar el comprobante, intente nuevamente en unos minutos", code: "internal_error" },
      { status: 500, headers: NO_STORE },
    )
  }
}
