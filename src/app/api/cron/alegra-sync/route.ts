import { getDb } from "@/db"
import { tenants as tenantsTable } from "@/db/schema"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { syncCatalog } from "@/lib/alegra-sync"
import { bearerMatches } from "@/lib/secure-compare"

// Sincroniza TODOS los tenants en una sola invocación: necesita más margen que la sync manual.
export const maxDuration = 300

// Sincroniza el catálogo de Alegra a la cache de todos los tenants con Alegra configurado.
// Lo invoca Vercel Cron (o curl en dev) con CRON_SECRET. Best-effort por tenant. Ver ADR catálogo.
export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  try {
    const rows = await getDb().select({ id: tenantsTable.id }).from(tenantsTable)
    const results: Array<{ tenant: string; ok: boolean; itemsSynced: number; categoriesSynced: number; error?: string }> = []
    for (const { id } of rows) {
      const cfg = await getTenantByIdFromDb(id)
      // Sin Alegra configurado (ni mock ni token) → saltear.
      if (!cfg || (!cfg.alegraMock && !cfg.alegraToken)) continue
      results.push({ tenant: id, ...(await syncCatalog(cfg, "cron")) })
    }
    return Response.json({ tenants: results })
  } catch (err) {
    console.error("cron/alegra-sync error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}

// Vercel Cron usa GET
export const GET = POST
