import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"

// GET /api/agent/payment-conditions
// Devuelve las condiciones de pago configuradas para el tenant.
export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) {
      console.warn("[agent/payment-conditions] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const db = getDb()

    const [row] = await db
      .select({ paymentConditions: tenants.paymentConditions })
      .from(tenants)
      .where(eq(tenants.id, tenant.id))

    const conditions = (row?.paymentConditions ?? []) as unknown[]
    console.log(`[agent/payment-conditions] tenant=${tenant.id} cliente=${auth.codigocliente} → ${conditions.length} condiciones`)

    return Response.json(conditions)
  } catch (err) {
    console.error("agent/payment-conditions error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
