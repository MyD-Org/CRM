import { eq, and, or, ilike, desc } from "drizzle-orm"
import { getDb } from "@/db"
import { catalogItems, priceLists } from "@/db/schema"
import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"

// GET /api/agent/catalog?q=cable+10mm
// Busca productos en la lista de precios ACTIVA del tenant (subida por Excel).
// Fuente: catalog_items + price_lists (active=true). Devuelve hasta 20.
// El campo `id` es el uuid del item — la tool no confirma precio en vivo (no hay Alegra).
export async function GET(req: Request) {
  try {
    const tenant = await getTenantConfig()
    const auth = authAgentTenantRequest(req, tenant.id)
    if (!auth) {
      console.warn("[agent/catalog] 401 — request sin crm_token válido (Authorization Bearer)")
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const url = new URL(req.url)
    const q = url.searchParams.get("q")?.trim() ?? ""

    console.log(`[agent/catalog] tenant=${tenant.id} cliente=${auth.codigocliente} q="${q}"`)

    if (!q) return Response.json({ error: "q es requerido" }, { status: 400 })

    const db = getDb()

    // Lista activa del tenant (upload garantiza solo una activa por vez).
    const [activeList] = await db
      .select({ id: priceLists.id, priceColumns: priceLists.priceColumns })
      .from(priceLists)
      .where(and(eq(priceLists.tenantId, tenant.id), eq(priceLists.active, true)))
      .orderBy(desc(priceLists.uploadedAt))
      .limit(1)

    if (!activeList) {
      console.log(`[agent/catalog] sin lista activa → 0 productos`)
      return Response.json({ priceColumns: [], products: [] })
    }

    const rows = await db
      .select()
      .from(catalogItems)
      .where(
        and(
          eq(catalogItems.tenantId, tenant.id),
          eq(catalogItems.priceListId, activeList.id),
          or(ilike(catalogItems.description, `%${q}%`), ilike(catalogItems.code, `%${q}%`)),
        ),
      )
      .limit(20)

    const priceColumns = (activeList.priceColumns as { key: string; label: string }[]) ?? []

    console.log(`[agent/catalog] lista=${activeList.id} → ${rows.length} productos`)

    return Response.json({
      priceColumns,
      products: rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.description,
        description: r.description,
        stock: null,
        prices: r.prices as Record<string, string>,
      })),
    })
  } catch (err) {
    console.error("agent/catalog error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
