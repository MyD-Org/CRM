import { and, eq, isNotNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, tenants } from "@/db/schema"

// Endpoint interno: ai-api consulta los operadores activos del tenant para la
// tool assign_to_human. Auth via INTERNAL_SECRET.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization")
  if (!process.env.INTERNAL_SECRET || auth !== `Bearer ${process.env.INTERNAL_SECRET}`) {
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

  const operators = await getDb()
    .select({ id: adminUsers.id, name: adminUsers.name, department: adminUsers.department })
    .from(adminUsers)
    .where(and(eq(adminUsers.tenantId, tenant.id), isNotNull(adminUsers.passwordHash)))

  return Response.json(operators)
}
