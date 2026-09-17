import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { crearOpcion, listarOpciones, toOpcionDto } from "@/lib/cuotas-repo"
import { cuotasErrorResponse, NO_STORE } from "@/lib/cuotas-respuestas"
import { pingShopRevalidarCuotas } from "@/lib/shop-revalidar"

// GET  /api/admin/cuotas/opciones — opciones de cuotas del tenant (todas, con su medio).
// POST /api/admin/cuotas/opciones — alta { paymentMethodId, cuotas, sinInteres?, montoMinimo?,
//      vigenteDesde?, vigenteHasta?, activo? }. Validación en src/lib/cuotas.ts; superposición
//      con advisory lock en src/lib/cuotas-repo.ts. Medio de otro tenant → 404.

export async function GET(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const opciones = await listarOpciones(guard.tenantId)
  return Response.json({ opciones: opciones.map(toOpcionDto) }, { headers: NO_STORE })
}

export async function POST(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const body = await req.json().catch(() => null)
  const r = await crearOpcion(guard.tenantId, body, guard.user.id)
  if (r.kind === "not_found") return adminNotFoundResponse()
  if (r.kind !== "ok") return cuotasErrorResponse(r)

  const { propagado } = await pingShopRevalidarCuotas()
  return Response.json({ ok: true, propagado, opcion: toOpcionDto(r.row) }, { status: 201, headers: NO_STORE })
}
