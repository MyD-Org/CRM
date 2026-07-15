import { asc, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { departments, tenants } from "@/db/schema"
import { bearerMatches } from "@/lib/secure-compare"

// Endpoint interno: ai-api consulta el catálogo de departamentos del tenant para inyectarlo
// en el agente y rutear los handoffs. Mismo patrón de auth que /api/internal/operators
// (INTERNAL_SECRET). El tenantId que llega es el aiTenantId (UUID de ai-api), no el slug local.
export async function GET(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const aiTenantId = searchParams.get("tenantId")
  if (!aiTenantId) return Response.json({ error: "missing tenantId" }, { status: 400 })

  const [tenant] = await getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.aiTenantId, aiTenantId))

  if (!tenant) return Response.json([], { status: 200 })

  const rows = await getDb()
    .select({ key: departments.key, label: departments.label })
    .from(departments)
    .where(eq(departments.tenantId, tenant.id))
    .orderBy(asc(departments.label))

  return Response.json(rows)
}
