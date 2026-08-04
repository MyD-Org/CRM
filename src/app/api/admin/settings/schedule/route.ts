import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { normalizeSchedule, normalizeExceptions, parseSchedule, parseExceptions } from "@/lib/schedule"
import { roleRank } from "@/lib/roles"
// notes ya no se carga a mano: el ai-api lo recibe generado a partir de las excepciones
// (ver exceptionsToNotes en el endpoint interno). Acá solo persistimos schedule + exceptions.
// Autorización: admin y superadmin (rank ≥ 1). El operator no puede tocar horarios.

async function getSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

function canEditSchedule(role: string): boolean {
  return roleRank(role) >= 1
}

// GET /api/admin/settings/schedule → { schedule: WeeklySchedule, exceptions: ScheduleException[] }
export async function GET() {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })
  if (!canEditSchedule(session.role)) return NextResponse.json({ error: "prohibido" }, { status: 403 })

  const db = getDb()
  const [tenant] = await db
    .select({ schedule: tenants.schedule, scheduleExceptions: tenants.scheduleExceptions })
    .from(tenants)
    .where(eq(tenants.id, session.tenantId))

  return NextResponse.json({
    schedule: normalizeSchedule(tenant?.schedule),
    exceptions: normalizeExceptions(tenant?.scheduleExceptions),
  })
}

// PUT /api/admin/settings/schedule
// Body: { schedule: WeeklySchedule, exceptions?: ScheduleException[] }
//   schedule: franjas por día ("HH:MM"); día sin franjas = cerrado
//   exceptions: feriados/vacaciones (closed) u horario especial en una fecha (special)
export async function PUT(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })
  if (!canEditSchedule(session.role)) return NextResponse.json({ error: "prohibido" }, { status: 403 })

  const body = (await req.json()) as { schedule?: unknown; exceptions?: unknown }

  const parsed = parseSchedule(body.schedule)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const parsedEx = parseExceptions(body.exceptions)
  if (!parsedEx.ok) {
    return NextResponse.json({ error: parsedEx.error }, { status: 400 })
  }

  const db = getDb()
  await db
    .update(tenants)
    .set({
      schedule: parsed.schedule,
      scheduleExceptions: parsedEx.exceptions,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, session.tenantId))

  return NextResponse.json({ ok: true, schedule: parsed.schedule, exceptions: parsedEx.exceptions })
}
