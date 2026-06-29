import { and, eq, isNotNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, tenants } from "@/db/schema"

// Endpoint interno: ai-api consulta los operadores con cuenta activada del tenant para
// inyectar el catálogo de derivación en el agente y rutear el handoff por departamento.
// Incluye la presencia (`available`). Auth via INTERNAL_SECRET. Ver ADR 0006.
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

  const rows = await getDb()
    .select({
      id: adminUsers.id,
      name: adminUsers.name,
      department: adminUsers.department,
      availability: adminUsers.availability,
    })
    .from(adminUsers)
    .where(and(eq(adminUsers.tenantId, tenant.id), isNotNull(adminUsers.passwordHash)))

  // ai-api decide a quién asignar; el CRM solo reporta la presencia. `available` = el
  // operador se marcó disponible en el inbox.
  const operators = rows.map(({ availability, ...rest }) => ({
    ...rest,
    available: availability === "available",
  }))

  return Response.json(operators)
}
