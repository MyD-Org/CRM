import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { actualizarEscalon, borrarEscalon, toEscalonDto } from "@/lib/cuotas-repo"
import { cuotasErrorResponse, NO_STORE } from "@/lib/cuotas-respuestas"
import { pingShopRevalidarCuotas } from "@/lib/shop-revalidar"

// PATCH  /api/admin/cuotas/escalones/[id] — edición parcial (desactivar = { activo: false }).
// DELETE /api/admin/cuotas/escalones/[id] — borrado definitivo.
// Id inexistente o de otro tenant → el mismo 404 que el guard. Ping al Shop tras persistir.

type IdParams = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  const body = await req.json().catch(() => null)
  const r = await actualizarEscalon(guard.tenantId, id, body, guard.user.id)
  if (r.kind === "not_found") return adminNotFoundResponse()
  if (r.kind !== "ok") return cuotasErrorResponse(r)

  const { propagado } = await pingShopRevalidarCuotas()
  return Response.json({ ok: true, propagado, escalon: toEscalonDto(r.row) }, { headers: NO_STORE })
}

export async function DELETE(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  if (!(await borrarEscalon(guard.tenantId, id))) return adminNotFoundResponse()

  const { propagado } = await pingShopRevalidarCuotas()
  return Response.json({ ok: true, propagado }, { headers: NO_STORE })
}
