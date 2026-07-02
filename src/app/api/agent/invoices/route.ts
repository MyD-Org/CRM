import { getTenantConfig } from "@/lib/tenant-context"
import { getFacturas } from "@/lib/flexxus"
import { authAgentRequest } from "@/lib/agent-auth"

export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentRequest(req, tenant.id)
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 })

    const facturas = await getFacturas(tenant, auth.codigocliente)

    const status = new URL(req.url).searchParams.get("status")
    const filtered =
      status === "paid"
        ? facturas.filter((f) => f.estado === "pagada")
        : status === "pending"
          ? facturas.filter((f) => f.estado !== "pagada")
          : facturas

    return Response.json(
      filtered.map((f) => ({
        id: f.id,
        type: f.tipo,
        date: f.emision,
        due_date: f.vencimiento,
        total: f.importe,
        paid_amount: f.pagado ?? 0,
        balance: f.importe - (f.pagado ?? 0),
        status: f.estado,
      })),
    )
  } catch (err) {
    console.error("agent/invoices error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
