import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { bearerMatches } from "@/lib/secure-compare"
import { normalizeSchedule, normalizeExceptions, exceptionsToNotes } from "@/lib/schedule"

// Endpoint interno: el ai-api consulta el horario de atención del tenant para saber si está
// abierto y a qué hora. Devuelve el contrato canónico:
//   { notes: string | null, schedule: { monday: [{open,close}, ...], ..., sunday: [] } }
// `notes` se genera a partir de las excepciones (feriados/vacaciones/horario especial)
// renderizadas como texto que el agente lee. `schedule` siempre trae las 7 claves (día sin
// franjas = cerrado). Auth via INTERNAL_SECRET.
export async function GET(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const aiTenantId = searchParams.get("tenantId")
  if (!aiTenantId) return Response.json({ error: "missing tenantId" }, { status: 400 })

  const [tenant] = await getDb()
    .select({ schedule: tenants.schedule, scheduleExceptions: tenants.scheduleExceptions })
    .from(tenants)
    .where(eq(tenants.aiTenantId, aiTenantId))

  return Response.json({
    notes: exceptionsToNotes(normalizeExceptions(tenant?.scheduleExceptions)),
    schedule: normalizeSchedule(tenant?.schedule),
  })
}
