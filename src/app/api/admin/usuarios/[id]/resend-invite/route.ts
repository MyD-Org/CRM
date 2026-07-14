import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { Resend } from "resend"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens, tenants } from "@/db/schema"
import { generateToken } from "@/lib/admin-crypto"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// POST /api/admin/usuarios/:id/resend-invite
// Genera un token nuevo (invalida el anterior) y reintenta el envío del email.
// El inviteUrl (con el token crudo) se devuelve siempre para que el superadmin copie
// el link a mano desde la UI mientras no haya servidor de mail configurado.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId || session.role !== "superadmin") {
    return NextResponse.json({ error: "Se requiere rol superadmin" }, { status: 403 })
  }

  const { id } = await params
  const db = getDb()

  const [user] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.id, id), eq(adminUsers.tenantId, session.tenantId)))
  if (!user) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 })
  if (user.passwordHash) return NextResponse.json({ error: "El usuario ya activó su cuenta" }, { status: 409 })

  // Invalida tokens anteriores y genera uno nuevo
  await db.delete(adminPasswordTokens).where(
    and(eq(adminPasswordTokens.userId, user.id), eq(adminPasswordTokens.type, "invite")),
  )

  const { token, tokenHash } = generateToken()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await db.insert(adminPasswordTokens).values({ userId: user.id, tokenHash, type: "invite", expiresAt })

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  const inviteUrl = `${baseUrl}/admin/reset-password/${token}`

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.tenantId))

  let emailSent = true
  let emailError: string | undefined
  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const { error } = await resend.emails.send({
      from: tenant?.resendFrom ?? "noreply@example.com",
      to: user.email,
      subject: `Invitación al backoffice de ${tenant?.name ?? ""}`,
      html: `
        <p>Hola ${user.name},</p>
        <p>Fuiste invitado como <strong>${user.role === "superadmin" ? "Superadmin" : "Operador"}</strong> del backoffice.</p>
        <p><a href="${inviteUrl}">Aceptar invitación y crear contraseña</a></p>
        <p>El link vence en 7 días.</p>
      `,
    })
    if (error) {
      emailError = `${error.name}: ${error.message}`
      console.error("[resend-invite] Resend error:", emailError)
      emailSent = false
    }
  } catch (err) {
    emailError = err instanceof Error ? err.message : String(err)
    console.error("[resend-invite] Resend exception:", emailError)
    emailSent = false
  }

  // Devolvemos el inviteUrl siempre (también en prod): mientras no haya servidor de
  // mail configurado, el superadmin copia el link desde la UI y lo comparte a mano.
  return NextResponse.json({ ok: true, emailSent, emailError, expiresAt, inviteUrl })
}
