import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getContact, getContactMessages, getBotStatus } from "@/lib/inbox-api"
import { enrichContact } from "@/lib/inbox-contacts"
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

  const result = await Promise.all([
    getContact(tenant.aiApiUrl, tenant.aiTenantId, endUserId),
    getContactMessages(tenant.aiApiUrl, tenant.aiTenantId, endUserId, { limit: 30 }),
  ]).catch(() => null)

  if (!result) notFound()
  const [contact, page] = result

  // Operador (fuente de verdad: CRM) + departamento (de ai-api).
  const enrichedContact = await enrichContact(
    { id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId },
    contact,
  )
  // Estado del kill switch: si el bot está pausado, el footer no dice "el bot responde".
  const botEnabled = await getBotStatus(tenant.aiApiUrl, tenant.aiTenantId).catch(() => true)

  return <ContactThreadView contact={enrichedContact} initialPage={page} currentUserId={session.userId} botEnabled={botEnabled} />
}
