import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getBotStatus, setBotStatus } from "@/lib/inbox-api"

async function requireTenant() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return { error: NextResponse.json({ error: "no autorizado" }, { status: 401 }) }

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return { error: NextResponse.json({ error: "inbox no configurado" }, { status: 503 }) }
  }
  return { tenant }
}

export async function GET() {
  const { error, tenant } = await requireTenant()
  if (error) return error

  const botEnabled = await getBotStatus(tenant.aiApiUrl, tenant.aiTenantId)
  return NextResponse.json({ botEnabled })
}

export async function POST(req: NextRequest) {
  const { error, tenant } = await requireTenant()
  if (error) return error

  const body = await req.json().catch(() => null)
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled inválido" }, { status: 400 })
  }

  await setBotStatus(tenant.aiApiUrl, tenant.aiTenantId, body.enabled)
  return NextResponse.json({ botEnabled: body.enabled })
}
