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

  const params = new URL(req.url).searchParams
  const scope = params.get("scope") === "all" ? "all" : "active"
  const tenantRef = { id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId }

  // Reconciliación de la cola (adoptar asignaciones viejas + repartir pendientes al operador
  // disponible menos cargado, ADR 0006): solo cuando el cliente la pide con ?reconcile=1.
  // El inbox se pollea cada 10s por pestaña abierta; correr las ESCRITURAS en cada pasada era
  // carga constante sobre la DB sin nada nuevo que reconciliar el 99% de las veces. El cliente
  // la pide cada 60s (y el render del server ya reconcilia al entrar al inbox).
  // Best-effort: no rompe el listado. Reutilizamos lo que trajo para no re-consultarlo.
  const reconcile = params.get("reconcile") === "1"
  const { convs, assignments } = reconcile
    ? await assignPendingConversations(tenantRef)
    : { convs: undefined, assignments: undefined }

  const enriched = await listEnrichedContacts(tenantRef, scope, convs, assignments)
  return NextResponse.json(enriched)
}
