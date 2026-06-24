import { NextRequest, NextResponse } from "next/server"
import { and, eq, gt, isNull } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens } from "@/db/schema"
import { hashPassword, hashToken } from "@/lib/admin-crypto"

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
