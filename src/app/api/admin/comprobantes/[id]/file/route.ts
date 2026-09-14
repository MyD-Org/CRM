import { NextResponse } from "next/server"
import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { extFor } from "@/lib/receipt-file"
import { getAdmin } from "@/lib/payment-receipts"
import { getR2 } from "@/lib/r2"
import { GET_URL_TTL_SECONDS } from "@/lib/receipt-validation"

// GET /api/admin/comprobantes/[id]/file[?download=1] — visor del backoffice.
// NUNCA sirve bytes: responde 302 a una URL GET firmada corta (TTL 300 s) y el navegador
// va directo a R2. El inline/attachment ya vino en el PUT del confirm; con ?download=1 se
// firma además response-content-disposition=attachment para forzar la descarga.

type IdParams = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  const row = await getAdmin(guard.tenantId, id)
  // null (ajeno / uploading / processing / rejected) o sin archivo publicado ⇒ el MISMO
  // 404 que un id inexistente: sin oráculos de existencia.
  if (!row || !row.fileKey || !row.fileMime) return adminNotFoundResponse()

  const r2 = getR2()
  if (!r2) {
    return Response.json(
      { error: "El almacenamiento de comprobantes no está disponible, intente nuevamente más tarde", code: "storage_unavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    )
  }

  const download = new URL(req.url).searchParams.get("download") === "1"
  const url = await r2.presignGet(row.fileKey, {
    ttlSeconds: GET_URL_TTL_SECONDS,
    ...(download
      ? {
          responseContentDisposition:
            `attachment; filename="comprobante-${row.paidOn}-${row.id.slice(0, 8)}.${extFor(row.fileMime)}"`,
        }
      : {}),
  })

  const res = NextResponse.redirect(url, 302)
  res.headers.set("Cache-Control", "private, no-store")
  res.headers.set("Referrer-Policy", "no-referrer")
  return res
}
