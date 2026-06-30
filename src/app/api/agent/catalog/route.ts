import { eq, and, or, ilike } from "drizzle-orm"
import { getDb } from "@/db"
import { catalogProducts } from "@/db/schema"
import type { AlegraPrice } from "@/lib/alegra"
import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"

// GET /api/agent/catalog?q=cable+10mm
// Busca productos en la CACHE local del catálogo (sincronizada desde Alegra). Devuelve hasta 20.
// Precios = snapshot de la última sync (referencia). El precio EXACTO se confirma en vivo con la
// tool get_live_prices (/api/agent/prices) al armar el presupuesto. Ver ADR catálogo Alegra.
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
    const rows = await db
      .select()
      .from(catalogProducts)
      .where(
        and(
          eq(catalogProducts.tenantId, tenant.id),
          eq(catalogProducts.status, "active"),
          or(ilike(catalogProducts.name, `%${q}%`), ilike(catalogProducts.code, `%${q}%`)),
        ),
      )
      .limit(20)

    // Columnas de precio (union de listas presentes en los resultados), para que el agente sepa
    // qué significa cada precio.
    const colMap = new Map<string, string>()
    for (const r of rows) for (const p of (r.prices as AlegraPrice[]) ?? []) colMap.set(p.idPriceList, p.name)
    const priceColumns = [...colMap].map(([key, label]) => ({ key, label }))

    console.log(`[agent/catalog] cache → ${rows.length} productos`)

    return Response.json({
      priceColumns,
      products: rows.map((r) => ({
        id: r.alegraId, // para confirmar precio en vivo con get_live_prices
        code: r.code,
        name: r.name,
        description: r.description,
        stock: r.stock,
        // precios de referencia (snapshot), keyed por lista
        prices: Object.fromEntries(((r.prices as AlegraPrice[]) ?? []).map((p) => [p.idPriceList, String(p.price)])),
      })),
    })
  } catch (err) {
    console.error("agent/catalog error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
