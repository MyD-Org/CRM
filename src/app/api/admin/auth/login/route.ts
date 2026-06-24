import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { verifyPassword } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email y contraseña requeridos" }, { status: 400 })
  }

  const db = getDb()
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, body.email.toLowerCase()))

  // Respuesta genérica para no filtrar si el email existe
  if (!user || !user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
    return NextResponse.json({ error: "Credenciales incorrectas" }, { status: 401 })
  }

  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  session.userId = user.id
  session.name = user.name
  session.email = user.email
  session.role = user.role as AdminSessionData["role"]
  session.tenantId = user.tenantId
  await session.save()

  return NextResponse.json({ ok: true })
}
