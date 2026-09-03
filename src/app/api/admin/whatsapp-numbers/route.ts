import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { listWhatsappNumbersRaw } from "@/lib/inbox-api"

// GET /api/admin/whatsapp-numbers — los números de WhatsApp del tenant, para elegir por
// cuál sale un envío proactivo (automatizaciones) o sobre qué WABA operar las plantillas.
//
// A diferencia de las plantillas, acá alcanza con staff: no expone credenciales ni crea
// nada en Meta, solo lista lo que ya está configurado.
export async function GET() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "canal no configurado" }, { status: 503 })
  }

  const res = await listWhatsappNumbersRaw(tenant.aiApiUrl, tenant.aiTenantId, session.role ?? "staff")
  const text = await res.text()
  return new NextResponse(text, { status: res.status, headers: { "content-type": "application/json" } })
}
