import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "body requerido" }, { status: 400 })

  // Solo superadmin puede editar a otros usuarios
  const isSelf = id === session.userId
  if (!isSelf && session.role !== "superadmin") {
    return NextResponse.json({ error: "Se requiere rol superadmin" }, { status: 403 })
  }

  const db = getDb()
  const [target] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.tenantId, session.tenantId)))
  if (!target) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })

  const updates: Partial<typeof adminUsers.$inferInsert> = {}
  if (body.name && typeof body.name === "string") updates.name = body.name.trim()
  // Solo superadmin puede cambiar roles (y no puede quitarse el suyo propio)
  if (body.role && session.role === "superadmin" && !isSelf) {
    if (!["operator", "superadmin"].includes(body.role)) {
      return NextResponse.json({ error: "role inválido" }, { status: 400 })
    }
    updates.role = body.role
  }

  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: "Sin campos para actualizar" }, { status: 400 })
  }

  const [updated] = await db.update(adminUsers).set(updates).where(eq(adminUsers.id, id)).returning()
  return NextResponse.json({ id: updated.id, name: updated.name, role: updated.role })
}
