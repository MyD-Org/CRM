import { adminNotFoundResponse, requireAdminPlus } from "@/lib/admin-route-guard"
import { crearProveedor, listarProveedores, toProveedorDto } from "@/lib/cuotas-repo"
import { cuotasErrorResponse, NO_STORE } from "@/lib/cuotas-respuestas"
import { pingShopRevalidarCuotas } from "@/lib/shop-revalidar"

// GET  /api/admin/cuotas/proveedores — proveedores de pago del tenant (activos e inactivos).
// POST /api/admin/cuotas/proveedores — alta { proveedor, activo?, orden? }; `proveedor` sale de la
//      lista fija (src/lib/cuotas.ts → PROVEEDORES), el nombre se deriva y no se tipea código.
// admin+ (requireAdminPlus: operator → 404). Tenant = el del guard; cualquier tenantId del body
// se ignora. Tras persistir se avisa al Shop (no bloqueante): la respuesta trae `propagado`.

export async function GET(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const proveedores = await listarProveedores(guard.tenantId)
  return Response.json({ proveedores: proveedores.map(toProveedorDto) }, { headers: NO_STORE })
}

export async function POST(req: Request) {
  const guard = await requireAdminPlus(req)
  if (!guard.ok) return guard.response

  const body = await req.json().catch(() => null)
  const r = await crearProveedor(guard.tenantId, body)
  if (r.kind === "not_found") return adminNotFoundResponse()
  if (r.kind !== "ok") return cuotasErrorResponse(r)

  const { propagado } = await pingShopRevalidarCuotas()
  return Response.json({ ok: true, propagado, proveedor: toProveedorDto(r.row) }, { status: 201, headers: NO_STORE })
}
