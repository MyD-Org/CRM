import { contratoCuotasV1 } from "@/lib/cuotas-repo"
import { bearerMatches } from "@/lib/secure-compare"

// GET /api/internal/shop/cuotas?tenant={tenants.id} — el Shop lee qué medios de pago y opciones
// de cuotas ofrece el tenant. Contrato: platform/contracts/cuotas/v1 (schema.json).
// Auth: Bearer SHOP_CRM_SECRET, una llave propia del Shop. NO INTERNAL_SECRET: esa es la de ai-api y
// además abre /api/agent/* (facturas, saldos, contactos); el Shop no tiene que tener ese acceso.
// El tenant se busca por `tenants.id`, no por `aiTenantId`. Sólo lectura; nunca se cachea.

const NO_STORE = { "Cache-Control": "no-store" }

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.SHOP_CRM_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE })
  }

  const tenant = new URL(req.url).searchParams.get("tenant")?.trim()
  if (!tenant) return Response.json({ error: "missing tenant" }, { status: 400, headers: NO_STORE })

  const payload = await contratoCuotasV1(tenant)
  if (!payload) return Response.json({ error: "tenant not found" }, { status: 404, headers: NO_STORE })

  return Response.json(payload, { headers: NO_STORE })
}
