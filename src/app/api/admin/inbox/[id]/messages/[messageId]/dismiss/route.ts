import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { dismissMessage } from "@/lib/inbox-api"

// POST /api/admin/inbox/:id/messages/:messageId/dismiss
// Descarta una burbuja saliente fallida (el operador decide no reintentarla). El mensaje
// sigue en el thread marcado como cancelado y deja de contar para el flag "Falló envío"
// del inbox.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id, messageId } = await params
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  const result = await dismissMessage(tenant.aiApiUrl, tenant.aiTenantId, id, messageId)
  if (!result.ok) {
    const status = result.error === "not_failed" ? 409 : 502
    return NextResponse.json({ error: result.error }, { status })
  }
  return NextResponse.json({ ok: true })
}
