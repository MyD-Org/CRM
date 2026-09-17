import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { crearEscalon, listarEscalones, toEscalonDto } from "@/lib/cuotas-repo"
import { cuotasErrorResponse, NO_STORE } from "@/lib/cuotas-respuestas"
import { pingShopRevalidarCuotas } from "@/lib/shop-revalidar"

// GET  /api/admin/cuotas/escalones — escalones de cuotas del tenant (todos, con su proveedor).
// POST /api/admin/cuotas/escalones — alta { proveedorId, cuotasMax, montoMinimo?, activo? }.
//      Validación en src/lib/cuotas.ts; monto mínimo repetido con advisory lock en
//      src/lib/cuotas-repo.ts. Proveedor de otro tenant → 404.

export async function GET(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const escalones = await listarEscalones(guard.tenantId)
  return Response.json({ escalones: escalones.map(toEscalonDto) }, { headers: NO_STORE })
}

export async function POST(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const body = await req.json().catch(() => null)
  const r = await crearEscalon(guard.tenantId, body, guard.user.id)
  if (r.kind === "not_found") return adminNotFoundResponse()
  if (r.kind !== "ok") return cuotasErrorResponse(r)

  const { propagado } = await pingShopRevalidarCuotas()
  return Response.json({ ok: true, propagado, escalon: toEscalonDto(r.row) }, { status: 201, headers: NO_STORE })
}
