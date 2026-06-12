import { getTenantConfig } from "@/lib/tenant-context"
import { getPagos } from "@/lib/flexxus"
import { authAgentRequest } from "@/lib/agent-auth"

export async function GET(req: Request) {
  try {
    const auth = authAgentRequest(req)
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 })

    const tenant = await getTenantConfig()
    const pagos = await getPagos(tenant, auth.codigocliente)

    return Response.json(
      pagos.map((p) => ({
        id: p.id,
        date: p.fecha,
        amount: p.monto,
        method: p.medio,
        invoices: p.facturas.map((imp) => ({ id: imp.factura, applied: imp.imputado })),
      })),
    )
  } catch (err) {
    console.error("agent/payments error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
