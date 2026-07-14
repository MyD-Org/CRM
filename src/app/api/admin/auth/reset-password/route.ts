import { NextRequest, NextResponse } from "next/server"
import { and, eq, gt, isNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens } from "@/db/schema"
import { hashPassword, hashToken } from "@/lib/admin-crypto"

// GET /api/admin/auth/reset-password?token=... — valida el token SIN consumirlo y
// devuelve el email de la cuenta y el estado, para que la página muestre de qué cuenta
// se trata y avise al instante si el link venció o ya fue usado.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  if (!token) return NextResponse.json({ valid: false }, { status: 400 })

  const db = getDb()
  const tokenHash = hashToken(token)
  const [row] = await db
    .select({
      email: adminUsers.email,
      usedAt: adminPasswordTokens.usedAt,
      expiresAt: adminPasswordTokens.expiresAt,
    })
    .from(adminPasswordTokens)
    .innerJoin(adminUsers, eq(adminPasswordTokens.userId, adminUsers.id))
    .where(eq(adminPasswordTokens.tokenHash, tokenHash))

  if (!row) return NextResponse.json({ valid: false })
  if (row.usedAt) return NextResponse.json({ valid: false, used: true })
  if (row.expiresAt < new Date()) return NextResponse.json({ valid: false, expired: true })
  return NextResponse.json({ valid: true, email: row.email })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.token || !body?.password) {
    return NextResponse.json({ error: "token y contraseña requeridos" }, { status: 400 })
  }
  if (body.password.length < 8) {
    return NextResponse.json({ error: "La contraseña debe tener al menos 8 caracteres" }, { status: 400 })
  }

  const db = getDb()
  const tokenHash = hashToken(body.token)
  const [tokenRow] = await db
    .select()
    .from(adminPasswordTokens)
    .where(
      and(
        eq(adminPasswordTokens.tokenHash, tokenHash),
        isNull(adminPasswordTokens.usedAt),
        gt(adminPasswordTokens.expiresAt, new Date()),
      ),
    )

  if (!tokenRow) return NextResponse.json({ error: "Link inválido o vencido" }, { status: 400 })

  const passwordHash = await hashPassword(body.password)
  await Promise.all([
    db.update(adminUsers).set({ passwordHash }).where(eq(adminUsers.id, tokenRow.userId)),
    db.update(adminPasswordTokens).set({ usedAt: new Date() }).where(eq(adminPasswordTokens.id, tokenRow.id)),
  ])

  return NextResponse.json({ ok: true })
}
