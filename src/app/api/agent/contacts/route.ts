import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"
import { searchContacts } from "@/lib/alegra"

// GET /api/agent/contacts?q=san+martin
// Busca clientes en Alegra por nombre o CUIT/identificación. Lo usa la tool del agente
// para resolver a qué contacto cotizarle antes de crear la cotización (POST /api/agent/quotes).
export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) {
      console.warn("[agent/contacts] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const url = new URL(req.url)
    const q = url.searchParams.get("q")?.trim() ?? ""
    if (!q) return Response.json({ error: "q es requerido" }, { status: 400 })

    const contacts = await searchContacts(tenant, q)
    console.log(`[agent/contacts] tenant=${tenant.id} cliente=${auth.codigocliente} q="${q}" → ${contacts.length}`)

    return Response.json({
      contacts: contacts.map((c) => ({
        id: c.alegraId,
        name: c.name,
        identification: c.identification,
        email: c.email,
        phone: c.phone,
        price_list_id: c.priceListId,
        seller_id: c.sellerId,
        payment_term_id: c.paymentTermId,
      })),
    })
  } catch (err) {
    console.error("agent/contacts error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
