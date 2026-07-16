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
  // Solo superadmin puede cambiar roles y departamentos (y no puede quitarse el rol propio)
  if (session.role === "superadmin" && !isSelf) {
    if (body.role) {
      if (!["operator", "superadmin"].includes(body.role)) {
        return NextResponse.json({ error: "role inválido" }, { status: 400 })
      }
      updates.role = body.role
    }
    if (Array.isArray(body.departments)) {
      updates.departments = body.departments.map((d: unknown) => String(d).trim()).filter(Boolean)
    }
  }

  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: "Sin campos para actualizar" }, { status: 400 })
  }

  const [updated] = await db.update(adminUsers).set(updates).where(eq(adminUsers.id, id)).returning()

  // Si el usuario editó su propio nombre, actualizar la sesión para que se refleje de inmediato
  if (isSelf && updates.name) {
    session.name = updated.name
    await session.save()
  }

  return NextResponse.json({ id: updated.id, name: updated.name, role: updated.role, departments: updated.departments })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })
  if (session.role !== "superadmin") return NextResponse.json({ error: "Se requiere rol superadmin" }, { status: 403 })

  const { id } = await params
  if (id === session.userId) return NextResponse.json({ error: "No podés eliminarte a vos mismo" }, { status: 400 })

  const db = getDb()
  const [target] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.tenantId, session.tenantId)))
  if (!target) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })

  await db.delete(adminUsers).where(eq(adminUsers.id, id))
  return NextResponse.json({ ok: true })
}
