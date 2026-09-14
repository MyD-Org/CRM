import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { getAdmin, setLoaded, toAdminDto } from "@/lib/payment-receipts"

// GET /api/admin/comprobantes/[id] — detalle (solo `pending`/`loaded`; cualquier otro
// estado o id ajeno responde EL MISMO 404 que adminNotFoundResponse, igual que el guard
// de operator: nadie puede distinguir "no existe" de "no lo puedo ver").
//
// PATCH /api/admin/comprobantes/[id] — marcar cargado en Alegra / deshacer
// (body { status: "loaded" | "pending" }). Idempotente: repetir el PATCH con el estado
// actual responde 200 igual. `loaded_by_name` sale de la fila fresca de la DB. No hay
// tabla de auditoría en v1: se loguea console.info estructurado con el actor y el id.

const NO_STORE = { "Cache-Control": "private, no-store" }

type IdParams = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  const row = await getAdmin(guard.tenantId, id)
  if (!row) return adminNotFoundResponse()

  return Response.json(toAdminDto(row, new Date()), { headers: NO_STORE })
}

export async function PATCH(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const body = await req.json().catch(() => null)
  const to = body?.status
  if (to !== "loaded" && to !== "pending") {
    return Response.json(
      { error: "El estado es inválido: use \"loaded\" o \"pending\"", code: "invalid" },
      { status: 400, headers: NO_STORE },
    )
  }

  const { id } = await params
  const now = new Date()
  const result = await setLoaded(guard.tenantId, id, to, guard.user.id, now)
  if (result.kind === "not_found") return adminNotFoundResponse()

  console.info(
    JSON.stringify({
      event: "payment_receipt_status_changed",
      tenant: guard.tenantId,
      receiptId: id,
      to,
      result: result.kind,
      actor: { id: guard.user.id, name: guard.user.name, email: guard.user.email },
      at: now.toISOString(),
    }),
  )

  return Response.json(toAdminDto(result.row, now), { headers: NO_STORE })
}
