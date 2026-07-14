import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getUsageSummary } from "@/lib/inbox-api"
import { botUsagePanelEnabled } from "@/lib/flags"

export async function GET(req: NextRequest) {
  // Feature gateada por flag (migrará a ia-dashboard).
  if (!(await botUsagePanelEnabled())) return NextResponse.json({ error: "no encontrado" }, { status: 404 })

  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })
  // El gasto es información de nivel administración: solo superadmin.
  if (session.role !== "superadmin") return NextResponse.json({ error: "prohibido" }, { status: 403 })

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days")) || 30, 1), 90)
  const summary = await getUsageSummary(tenant.aiApiUrl, tenant.aiTenantId, days)
  return NextResponse.json(summary)
}
