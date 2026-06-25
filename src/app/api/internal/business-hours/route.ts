import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"

// Endpoint interno: ai-api consulta los horarios de atención del tenant para
// incluirlos en el mensaje de handoff automático. Auth via INTERNAL_SECRET.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization")
  if (!process.env.INTERNAL_SECRET || auth !== `Bearer ${process.env.INTERNAL_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const aiTenantId = searchParams.get("tenantId")
  if (!aiTenantId) return Response.json({ error: "missing tenantId" }, { status: 400 })

  const [tenant] = await getDb()
    .select({ businessHours: tenants.businessHours })
    .from(tenants)
    .where(eq(tenants.aiTenantId, aiTenantId))

  return Response.json({ businessHours: tenant?.businessHours ?? null })
}
