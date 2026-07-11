import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"
import { createEstimate, listEstimatesByContact } from "@/lib/alegra"

// Cotizaciones (estimates de Alegra) para el agente. Es la única escritura contra Alegra
// que exponemos: una cotización no es documento fiscal y se puede borrar desde Alegra si
// hizo falta. NO crear facturas/pagos desde el agente.
//
// POST /api/agent/quotes
//   body: { contact_id, items: [{ id, quantity, price?, discount? }], due_date?, notes? }
//   Crea la cotización en Alegra para ese contacto y devuelve el resumen.
//
// GET /api/agent/quotes?contact_id=123
//   Últimas cotizaciones del contacto ("¿qué le coticé?").

interface QuoteItemBody {
  id?: unknown
  quantity?: unknown
  price?: unknown
  discount?: unknown
}
interface QuoteBody {
  contact_id?: unknown
  items?: unknown
  due_date?: unknown
  notes?: unknown
}

function serializeQuote(e: Awaited<ReturnType<typeof createEstimate>>) {
  return {
    id: e.alegraId,
    number: e.number,
    date: e.date,
    due_date: e.dueDate,
    contact_id: e.clientAlegraId,
    contact_name: e.clientName,
    status: e.status,
    total: e.total,
    notes: e.observations,
    items: e.items.map((it) => ({
      id: it.alegraId,
      name: it.name,
      quantity: it.quantity,
      price: it.price,
      discount: it.discount,
    })),
  }
}

export async function POST(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) {
      console.warn("[agent/quotes] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const body = (await req.json().catch(() => null)) as QuoteBody | null
    if (!body || typeof body.contact_id !== "string" || !body.contact_id.trim()) {
      return Response.json({ error: "contact_id es requerido" }, { status: 400 })
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return Response.json({ error: "items es requerido (al menos uno)" }, { status: 400 })
    }

    const items = []
    for (const raw of body.items as QuoteItemBody[]) {
      const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : ""
      const quantity = Number(raw.quantity)
      if (!id || !Number.isFinite(quantity) || quantity <= 0) {
        return Response.json({ error: "cada item requiere id y quantity > 0" }, { status: 400 })
      }
      items.push({
        alegraId: id,
        quantity,
        ...(raw.price !== undefined ? { price: Number(raw.price) } : {}),
        ...(raw.discount !== undefined ? { discount: Number(raw.discount) } : {}),
      })
    }

    const estimate = await createEstimate(tenant, {
      contactAlegraId: body.contact_id.trim(),
      items,
      ...(typeof body.due_date === "string" && body.due_date ? { dueDate: body.due_date } : {}),
      ...(typeof body.notes === "string" && body.notes ? { observations: body.notes } : {}),
    })

    console.log(
      `[agent/quotes] tenant=${tenant.id} cliente=${auth.codigocliente} → cotización ${estimate.alegraId} (total ${estimate.total})`,
    )

    return Response.json(serializeQuote(estimate), { status: 201 })
  } catch (err) {
    console.error("agent/quotes POST error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 })

    const url = new URL(req.url)
    const contactId = url.searchParams.get("contact_id")?.trim() ?? ""
    if (!contactId) return Response.json({ error: "contact_id es requerido" }, { status: 400 })

    const estimates = await listEstimatesByContact(tenant, contactId)
    console.log(`[agent/quotes] tenant=${tenant.id} contact=${contactId} → ${estimates.length} cotizaciones`)

    return Response.json({ quotes: estimates.map(serializeQuote) })
  } catch (err) {
    console.error("agent/quotes GET error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
