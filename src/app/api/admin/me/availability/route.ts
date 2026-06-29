import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

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

  return NextResponse.json({ availability })
}
