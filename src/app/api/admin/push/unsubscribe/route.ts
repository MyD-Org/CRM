import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { pushSubscriptions } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// POST /api/admin/push/unsubscribe
// Borra la suscripción por endpoint (el operador desactivó las notificaciones en este browser).
export async function POST(req: NextRequest) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const endpoint: unknown = body?.endpoint
  if (typeof endpoint !== "string") {
    return NextResponse.json({ error: "endpoint requerido" }, { status: 400 })
  }

  await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
  return NextResponse.json({ ok: true })
}
