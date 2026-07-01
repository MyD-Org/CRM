import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { startAssist } from "@/lib/inbox-api"

// Copiloto del operador (ADR 0007). Busca-o-crea el hilo de asistencia del contacto en ai-api y
// devuelve al widget la conversación pre-creada + el session token (que el widget refresca
// re-llamando a este mismo endpoint). El baseUrl es el rewrite same-origin /ai-api.
export async function POST(_req: Request, { params }: { params: Promise<{ endUserId: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { endUserId } = await params
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  const result = await startAssist(tenant.aiApiUrl, tenant.aiTenantId, endUserId)
  if (!result.ok) {
    const status = result.error === "contact_not_found" ? 404
      : result.error === "assist_agent_not_configured" ? 409
      : 502
    return NextResponse.json({ error: result.error }, { status })
  }

  return NextResponse.json({
    conversationId: result.session.conversationId,
    token: result.session.token,
    agentId: result.session.agentId,
    baseUrl: "/ai-api",
  })
}
