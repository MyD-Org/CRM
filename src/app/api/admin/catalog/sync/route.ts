import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { desc, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { catalogSyncLog } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { syncCatalog } from "@/lib/alegra-sync"

// Catálogos grandes pueden necesitar varias tandas de páginas a Alegra (30 items/página,
// tope de la API). El default de la plataforma no alcanzaba y la sync daba 504.
export const maxDuration = 300

// POST: dispara una sincronización manual del catálogo con Alegra (botón del admin).
export async function POST() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return Response.json({ error: "no autorizado" }, { status: 401 })

  const tenant = await getTenantByIdFromDb(session.tenantId)
  if (!tenant) return Response.json({ error: "tenant no encontrado" }, { status: 404 })

  const result = await syncCatalog(tenant, "manual")
  return Response.json(result, { status: result.ok ? 200 : 502 })
}

// GET: última sincronización (para mostrar estado/fecha en el admin).
export async function GET() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return Response.json({ error: "no autorizado" }, { status: 401 })

  const [last] = await getDb()
    .select()
    .from(catalogSyncLog)
    .where(eq(catalogSyncLog.tenantId, session.tenantId))
    .orderBy(desc(catalogSyncLog.startedAt))
    .limit(1)

  return Response.json({ last: last ?? null })
}
