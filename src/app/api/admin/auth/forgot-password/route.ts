import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { Resend } from "resend"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens, tenants } from "@/db/schema"
import { generateToken } from "@/lib/admin-crypto"

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.email) return NextResponse.json({ error: "email requerido" }, { status: 400 })

  const db = getDb()
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, body.email.toLowerCase()))

  // Siempre responder OK para no filtrar si el email existe
  if (!user || !user.passwordHash) return NextResponse.json({ ok: true })

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId))
  const { token, tokenHash } = generateToken()
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1h

  await db.insert(adminPasswordTokens).values({ userId: user.id, tokenHash, type: "reset", expiresAt })

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  const resetUrl = `${baseUrl}/admin/reset-password/${token}`

  const resend = new Resend(process.env.RESEND_API_KEY)
  await resend.emails.send({
    from: tenant?.resendFrom ?? "noreply@example.com",
    to: user.email,
    subject: "Recuperar contraseña — Backoffice",
    html: `
      <p>Hola ${user.name},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña del backoffice.</p>
      <p><a href="${resetUrl}">Restablecer contraseña</a></p>
      <p>El link vence en 1 hora. Si no lo solicitaste, ignorá este email.</p>
    `,
  })

  return NextResponse.json({ ok: true })
}
