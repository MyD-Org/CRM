import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getContact, getContactMessages, getBotStatus, listConversations } from "@/lib/inbox-api"
import { enrichContact } from "@/lib/inbox-contacts"
import { getAssignments } from "@/lib/assignment"
import { operatorNamesByTenant } from "@/lib/operator-names"
import { ContactThreadView } from "@/components/admin/ContactThreadView"

export const dynamic = "force-dynamic"

export default async function ContactThreadPage({ params }: { params: Promise<{ endUserId: string }> }) {
  const { endUserId } = await params
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))

  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return (
      <div className="p-6">
        <div className="rounded-[var(--radius)] p-4 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          El inbox no está configurado.
        </div>
      </div>
    )
  }

  const tenantRef = { id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId }

  // Nada de esto depende del contacto, así que lo arrancamos ANTES de esperarlo: entrar a un
  // chat encadenaba 4 tandas (contacto+mensajes → enriquecido → nombre del operador → estado
  // del bot) cuando en realidad solo el enriquecido necesita el contacto, y solo para cruzar
  // ids en memoria. Todas llevan .catch(): si el contacto no existe salimos por notFound() sin
  // dejar promesas rechazadas sueltas.
  const conversationsP = listConversations(tenant.aiApiUrl, tenant.aiTenantId).catch(() => [])
  const assignmentsP = getAssignments(tenant.id).catch(() => [])
  const operatorNamesP = operatorNamesByTenant(tenant.id).catch(() => new Map<string, string>())
  // Estado del kill switch: si el bot está pausado, el footer no dice "el bot responde".
  const botStatusP = getBotStatus(tenant.aiApiUrl, tenant.aiTenantId).catch(() => true)

  const result = await Promise.all([
    getContact(tenant.aiApiUrl, tenant.aiTenantId, endUserId),
    getContactMessages(tenant.aiApiUrl, tenant.aiTenantId, endUserId, { limit: 30 }),
  ]).catch(() => null)

  if (!result) notFound()
  const [contact, page] = result

  // Operador (fuente de verdad: CRM) + departamento (de ai-api).
  const [enrichedContact, botEnabled] = await Promise.all([
    enrichContact(tenantRef, contact, {
      conversations: conversationsP,
      assignments: assignmentsP,
      operatorNames: operatorNamesP,
    }),
    botStatusP,
  ])

  return <ContactThreadView contact={enrichedContact} initialPage={page} currentUserId={session.userId} botEnabled={botEnabled} />
}
