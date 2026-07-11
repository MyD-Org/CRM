import { getTenantConfig } from "@/lib/tenant-context"
import { getCliente } from "@/lib/erp"
import { authAgentRequest } from "@/lib/agent-auth"

export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentRequest(req, tenant.id)
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 })

    const cliente = await getCliente(tenant, auth.codigocliente)

    return Response.json({
      current: -cliente.deudatotal,
      overdue: cliente.saldovencido,
      to_fall_due: cliente.saldoavencer,
      credit_limit: cliente.limitecredito,
      currency: "ARS",
    })
  } catch (err) {
    console.error("agent/account-balance error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
