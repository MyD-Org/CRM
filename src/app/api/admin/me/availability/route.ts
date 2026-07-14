import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { assignPendingConversations } from "@/lib/assignment"

// Presencia del operador logueado (toggle Disponible/Ausente del inbox). Ver ADR 0006.

export async function GET() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const [me] = await getDb()
    .select({ availability: adminUsers.availability })
    .from(adminUsers)
    .where(eq(adminUsers.id, session.userId))

  return NextResponse.json({ availability: me?.availability ?? "away" })
}

export async function PUT(req: NextRequest) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const availability = body?.availability
  if (availability !== "available" && availability !== "away") {
    return NextResponse.json({ error: "availability debe ser 'available' o 'away'" }, { status: 400 })
  }

  await getDb()
    .update(adminUsers)
    .set({ availability, availabilityChangedAt: new Date() })
    .where(eq(adminUsers.id, session.userId))

  // Al ponerse DISPONIBLE, reconciliamos la cola: puede haber conversaciones esperando
  // que ahora este operador (u otro) pueda tomar. Best-effort (no bloquea la respuesta).
  if (availability === "available") {
    const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
    if (tenant?.aiApiUrl && tenant?.aiTenantId) {
      try {
        await assignPendingConversations({ id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId })
      } catch {
        /* best-effort */
      }
    }
  }

  return NextResponse.json({ availability })
}
