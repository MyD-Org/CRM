import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { sendReply } from "@/lib/inbox-api"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body?.text?.trim()) return NextResponse.json({ error: "text requerido" }, { status: 400 })

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  const result = await sendReply(tenant.aiApiUrl, tenant.aiTenantId, id, body.text.trim())
  if (result.ok) return NextResponse.json({ id: result.id, ok: true })

  // Falla determinista: la ai-api NO persistió el mensaje (window_closed / no_recipient /
  // channel_not_configured). Devolvemos 409 sin id para que el cliente sepa que no hay
  // burbuja server-side y muestre el toast correspondiente.
  if (!("id" in result)) {
    const status = result.error === "window_closed" ? 409 : 502
    return NextResponse.json({ error: result.error }, { status })
  }

  // Envío falló pero el mensaje SÍ quedó persistido con delivery_status='failed'.
  // Devolvemos 200 con el id real para que el CRM reemplace el temp y muestre la burbuja
  // como "no entregado" (flujo de retry/dismiss que ya existe).
  return NextResponse.json({ id: result.id, ok: false, delivery_status: "failed", error: result.error })
}
