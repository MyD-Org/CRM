import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { assignPendingConversations } from "@/lib/assignment"
import { listEnrichedContacts } from "@/lib/inbox-contacts"

export async function GET(req: Request) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  const scope = new URL(req.url).searchParams.get("scope") === "all" ? "all" : "active"
  const tenantRef = { id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId }

  // Reconcilia la cola en cada poll: adopta asignaciones viejas y reparte pendientes al
  // operador disponible menos cargado. Best-effort (no rompe el listado). Ver ADR 0006.
  await assignPendingConversations(tenantRef)

  const enriched = await listEnrichedContacts(tenantRef, scope)
  return NextResponse.json(enriched)
}
