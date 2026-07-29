import { and, eq, or, sql } from "drizzle-orm"
import { getDb } from "@/db"
import { catalogProducts } from "@/db/schema"
import { authAgentTenantRequest } from "@/lib/agent-auth"
import { getTenantConfig } from "@/lib/tenant-context"

// GET /api/agent/catalog?q=enchufe
// Busca productos en el catálogo espejo de Alegra (catalog_products), refrescado por la sync
// (ver lib/alegra-sync.ts y el cron alegra-sync). Devuelve hasta 20 productos ACTIVOS.
// El `id` es el alegraId: el agente confirma precio/stock EN VIVO con get_live_prices
// (/api/agent/prices) antes de comprometer un número. Ver ADR catálogo Alegra
// (cache para buscar, live para el número que se compromete).
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

    // Tokenizamos por espacios y hacemos AND entre tokens: "disco de lija" matchea
    // "LIJA DISCO 140" aunque el orden difiera. Tokens de < 3 chars (ej. "de", "el") los
    // descartamos: agregan ruido por ILIKE (matchean cualquier cosa que contenga esa
    // subcadena). Si no queda ningún token útil, caemos a la frase original.
    // Sobre name/description/code aplicamos unaccent() en ambos lados: "termica" matchea
    // "Térmica" y "lija" matchea "lijá". ILIKE ya cubre el case.
    const tokens = q.split(/\s+/).filter((t) => t.length >= 3)
    const searchTerms = tokens.length > 0 ? tokens : [q]
    const tokenMatch = (t: string) =>
      or(
        sql`unaccent(${catalogProducts.name}) ILIKE unaccent(${`%${t}%`})`,
        sql`unaccent(${catalogProducts.description}) ILIKE unaccent(${`%${t}%`})`,
        sql`unaccent(${catalogProducts.code}) ILIKE unaccent(${`%${t}%`})`,
      )

    const rows = await db
      .select()
      .from(catalogProducts)
      .where(
        and(
          eq(catalogProducts.tenantId, tenant.id),
          eq(catalogProducts.status, "active"),
          ...searchTerms.map(tokenMatch),
        ),
      )
      .limit(20)

    console.log(`[agent/catalog] → ${rows.length} productos (alegra)`)

    return Response.json({
      products: rows.map((r) => {
        const prices = (r.prices as { idPriceList: string; name?: string; price: number | string }[]) ?? []
        return {
          id: r.alegraId,
          code: r.code,
          name: r.name,
          description: r.description,
          stock: r.stock,
          prices: Object.fromEntries(prices.map((p) => [p.idPriceList, String(p.price)])),
        }
      }),
    })
  } catch (err) {
    console.error("agent/catalog error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}
