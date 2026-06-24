import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { Resend } from "resend"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens, tenants } from "@/db/schema"
import { generateToken } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

async function getAdminSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

export async function GET() {
  const session = await getAdminSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const db = getDb()
  const users = await db
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.role, createdAt: adminUsers.createdAt, hasPassword: adminUsers.passwordHash })
    .from(adminUsers)
    .where(eq(adminUsers.tenantId, session.tenantId))

  return NextResponse.json(users.map((u) => ({ ...u, hasPassword: !!u.hasPassword })))
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession()
  if (!session.userId || session.role !== "superadmin") {
    return NextResponse.json({ error: "Se requiere rol superadmin" }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body?.email || !body?.name || !body?.role) {
    return NextResponse.json({ error: "email, name y role son requeridos" }, { status: 400 })
  }
  if (!["operator", "superadmin"].includes(body.role)) {
    return NextResponse.json({ error: "role inválido" }, { status: 400 })
  }

  const db = getDb()
  const existing = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, body.email.toLowerCase()))
  if (existing.length) return NextResponse.json({ error: "El email ya está en uso" }, { status: 409 })

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.tenantId))
  const [user] = await db.insert(adminUsers).values({
    tenantId: session.tenantId,
    email: body.email.toLowerCase(),
    name: body.name,
    role: body.role,
  }).returning()

  const { token, tokenHash } = generateToken()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 días para aceptar invitación
  await db.insert(adminPasswordTokens).values({ userId: user.id, tokenHash, type: "invite", expiresAt })

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  const inviteUrl = `${baseUrl}/admin/reset-password/${token}`

  const resend = new Resend(process.env.RESEND_API_KEY)
  await resend.emails.send({
    from: tenant?.resendFrom ?? "noreply@example.com",
    to: user.email,
    subject: `Invitación al backoffice de ${tenant?.name ?? ""}`,
    html: `
      <p>Hola ${user.name},</p>
      <p>Fuiste invitado como <strong>${body.role === "superadmin" ? "Superadmin" : "Operador"}</strong> del backoffice.</p>
      <p><a href="${inviteUrl}">Aceptar invitación y crear contraseña</a></p>
      <p>El link vence en 7 días.</p>
    `,
  })

  return NextResponse.json({ id: user.id, ok: true }, { status: 201 })
}
