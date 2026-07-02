import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq, isNull } from "drizzle-orm"
import { Resend } from "resend"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens, tenants } from "@/db/schema"
import { generateToken } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

async function getAdminSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

// Intenta enviar el email de invitación. Devuelve { sent, errorMsg }.
// Resend v6 retorna { data, error } sin tirar excepción en errores de API.
async function trySendInviteEmail({
  tenant,
  user,
  role,
  inviteUrl,
}: {
  tenant: { resendFrom?: string | null; name?: string | null } | undefined
  user: { email: string; name: string }
  role: string
  inviteUrl: string
}): Promise<{ sent: boolean; errorMsg?: string }> {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const { error } = await resend.emails.send({
      from: tenant?.resendFrom ?? "noreply@example.com",
      to: user.email,
      subject: `Invitación al backoffice de ${tenant?.name ?? ""}`,
      html: `
        <p>Hola ${user.name},</p>
        <p>Fuiste invitado como <strong>${role === "superadmin" ? "Superadmin" : "Operador"}</strong> del backoffice.</p>
        <p><a href="${inviteUrl}">Aceptar invitación y crear contraseña</a></p>
        <p>El link vence en 7 días.</p>
      `,
    })
    if (error) {
      const msg = `${error.name}: ${error.message}`
      console.error("[invite] Resend error:", msg)
      return { sent: false, errorMsg: msg }
    }
    return { sent: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[invite] Resend exception:", msg)
    return { sent: false, errorMsg: msg }
  }
}

export async function GET() {
  const session = await getAdminSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const db = getDb()
  const users = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      role: adminUsers.role,
      department: adminUsers.department,
      createdAt: adminUsers.createdAt,
      hasPassword: adminUsers.passwordHash,
      inviteExpiresAt: adminPasswordTokens.expiresAt,
      inviteAcceptedAt: adminPasswordTokens.usedAt,
    })
    .from(adminUsers)
    .leftJoin(
      adminPasswordTokens,
      and(eq(adminPasswordTokens.userId, adminUsers.id), eq(adminPasswordTokens.type, "invite")),
    )
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
  // Unicidad de email SCOPEADA al tenant: el mismo email puede existir en otro tenant
  // (multi-tenant). Chequear global bloquearía altas legítimas y filtraría existencia
  // de usuarios de otros tenants.
  const existing = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(and(eq(adminUsers.email, body.email.toLowerCase()), eq(adminUsers.tenantId, session.tenantId)))
  if (existing.length) return NextResponse.json({ error: "El email ya está en uso" }, { status: 409 })

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.tenantId))
  const [user] = await db.insert(adminUsers).values({
    tenantId: session.tenantId,
    email: body.email.toLowerCase(),
    name: body.name,
    role: body.role,
    department: body.department?.trim() || null,
  }).returning()

  const { token, tokenHash } = generateToken()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 días para aceptar invitación
  await db.insert(adminPasswordTokens).values({ userId: user.id, tokenHash, type: "invite", expiresAt })

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  const inviteUrl = `${baseUrl}/admin/reset-password/${token}`

  const { sent: emailSent, errorMsg: emailError } = await trySendInviteEmail({ tenant, user, role: body.role, inviteUrl })

  // El token crudo viaja SOLO por email. En prod no se devuelve en el body (evita
  // filtrarlo por logs/red); si el email falla, el admin usa el botón de reenvío.
  // En dev sí se expone para poder copiar el link sin servidor de mail configurado.
  const isProd = process.env.NODE_ENV === "production"
  return NextResponse.json(
    { id: user.id, ok: true, emailSent, emailError, ...(isProd ? {} : { inviteUrl }) },
    { status: 201 },
  )
}
