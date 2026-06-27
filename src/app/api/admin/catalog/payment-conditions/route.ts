import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

async function getSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

// GET /api/admin/catalog/payment-conditions
export async function GET() {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const db = getDb()
  const [tenant] = await db.select({ paymentConditions: tenants.paymentConditions }).from(tenants).where(eq(tenants.id, session.tenantId))

  return NextResponse.json(tenant?.paymentConditions ?? [])
}

// PUT /api/admin/catalog/payment-conditions
// Body: [{ method: "Transferencia", description: "5% de descuento" }, ...]
export async function PUT(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const body = await req.json()
  if (!Array.isArray(body)) {
    return NextResponse.json({ error: "se esperaba un array de condiciones" }, { status: 400 })
  }

  const db = getDb()
  await db.update(tenants).set({ paymentConditions: body, updatedAt: new Date() }).where(eq(tenants.id, session.tenantId))

  return NextResponse.json({ ok: true })
}
