import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"
import { listPaymentTerms } from "@/lib/alegra"

// GET /api/agent/payment-terms
// Condiciones de pago del tenant DESDE ALEGRA (endpoint /terms), no del CRM.
// Reemplaza como fuente a /api/agent/payment-conditions (que lee tenants.paymentConditions,
// cargado a mano). Devuelve las condiciones tal como están configuradas en Alegra.
export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) {
      console.warn("[agent/payment-terms] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const terms = await listPaymentTerms(tenant)
    console.log(`[agent/payment-terms] tenant=${tenant.id} cliente=${auth.codigocliente} → ${terms.length} términos (alegra)`)

    return Response.json(
      terms.map((t) => ({ id: t.alegraId, name: t.name, days: t.days })),
    )
  } catch (err) {
    console.error("agent/payment-terms error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
