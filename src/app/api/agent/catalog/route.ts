import { eq, and, or, ilike } from "drizzle-orm"
import { getDb } from "@/db"
import { priceLists, catalogItems } from "@/db/schema"
import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"

// GET /api/agent/catalog?q=cable+10mm
// Busca productos en la lista activa del tenant. Devuelve hasta 20 resultados.
export async function GET(req: Request) {
  try {
    const auth = authAgentTenantRequest(req)
    if (!auth) {
      console.warn("[agent/catalog] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const tenant = await getTenantConfig()
    const url = new URL(req.url)
    const q = url.searchParams.get("q")?.trim() ?? ""

    console.log(`[agent/catalog] tenant=${tenant.id} cliente=${auth.codigocliente} q="${q}"`)

    if (!q) return Response.json({ error: "q es requerido" }, { status: 400 })

    const db = getDb()

    // Buscar la lista activa del tenant
    const [activeList] = await db
      .select()
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenant.id), eq(priceLists.active, true)))
      .limit(1)

    if (!activeList) {
      return Response.json({ products: [], message: "No hay lista de precios cargada" })
    }

    const items = await db
      .select()
      .from(catalogItems)
      .where(
        and(
          eq(catalogItems.priceListId, activeList.id),
          or(ilike(catalogItems.description, `%${q}%`), ilike(catalogItems.code, `%${q}%`)),
        ),
      )
      .limit(20)

    const columns = activeList.priceColumns as { key: string; label: string }[]

    console.log(`[agent/catalog] lista="${activeList.name}" → ${items.length} productos`)

    return Response.json({
      category: activeList.name,
      priceColumns: columns,
      products: items.map((item) => ({
        code: item.code,
        description: item.description,
        prices: item.prices,
      })),
    })
  } catch (err) {
    console.error("agent/catalog error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
