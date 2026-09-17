import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { actualizarMedio, toMedioDto } from "@/lib/cuotas-repo"
import { cuotasErrorResponse, NO_STORE } from "@/lib/cuotas-respuestas"
import { pingShopRevalidarCuotas } from "@/lib/shop-revalidar"

// PATCH /api/admin/cuotas/medios/[id] — edición parcial (incluye desactivar con { activo: false }).
// No hay DELETE de medios: se desactivan (sus opciones dejan de viajar al Shop).
// Id inexistente o de otro tenant → el mismo 404 que el guard.

type IdParams = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: IdParams) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const { id } = await params
  const body = await req.json().catch(() => null)
  const r = await actualizarMedio(guard.tenantId, id, body)
  if (r.kind === "not_found") return adminNotFoundResponse()
  if (r.kind !== "ok") return cuotasErrorResponse(r)

  const { propagado } = await pingShopRevalidarCuotas()
  return Response.json({ ok: true, propagado, medio: toMedioDto(r.row) }, { headers: NO_STORE })
}
