import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

export async function POST() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  // Auto-away: al cerrar sesión el operador deja de estar disponible para asignación,
  // así no le caen handoffs estando desconectado. Ver ADR 0006.
  if (session.userId) {
    await getDb()
      .update(adminUsers)
      .set({ availability: "away", availabilityChangedAt: new Date() })
      .where(eq(adminUsers.id, session.userId))
  }
  session.destroy()
  return NextResponse.json({ ok: true })
}
