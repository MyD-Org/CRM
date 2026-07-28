import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { assignableRoles, canActOnRole, canManageUsers } from "@/lib/roles"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "body requerido" }, { status: 400 })

  const db = getDb()
  const [target] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.tenantId, session.tenantId)))
  if (!target) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })

  // Editar a OTRO requiere poder gestionar usuarios y tener autoridad sobre el rol del target
  // (un admin puede tocar operadores, no otros admins ni al superadmin). El auto-edit (nombre
  // propio) lo puede hacer cualquiera.
  const isSelf = id === session.userId
  if (!isSelf && (!canManageUsers(session.role) || !canActOnRole(session.role, target.role))) {
    return NextResponse.json({ error: "No tenés permisos sobre este usuario" }, { status: 403 })
  }

  const updates: Partial<typeof adminUsers.$inferInsert> = {}
  if (body.name && typeof body.name === "string") updates.name = body.name.trim()
  // Rol y departamentos: solo al gestionar a otro (no a uno mismo). El rol a asignar debe estar
  // dentro de lo que el actor puede otorgar (un admin no puede promover a admin/superadmin).
  if (!isSelf && canManageUsers(session.role)) {
    if (body.role) {
      if (!assignableRoles(session.role).includes(body.role)) {
        return NextResponse.json({ error: "No podés asignar ese rol" }, { status: 403 })
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
  if (!canManageUsers(session.role)) return NextResponse.json({ error: "No tenés permisos de gestión de usuarios" }, { status: 403 })

  const { id } = await params
  if (id === session.userId) return NextResponse.json({ error: "No podés eliminarte a vos mismo" }, { status: 400 })

  const db = getDb()
  const [target] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.tenantId, session.tenantId)))
  if (!target) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })

  // Un admin solo puede eliminar operadores; al superadmin y a otros admins, solo el superadmin.
  if (!canActOnRole(session.role, target.role)) {
    return NextResponse.json({ error: "No tenés permisos sobre este usuario" }, { status: 403 })
  }

  await db.delete(adminUsers).where(eq(adminUsers.id, id))
  return NextResponse.json({ ok: true })
}
