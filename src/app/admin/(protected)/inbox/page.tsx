import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getBotStatus, type InboxContact } from "@/lib/inbox-api"
import { assignPendingConversations } from "@/lib/assignment"
import { listEnrichedContacts } from "@/lib/inbox-contacts"
import { InboxList } from "@/components/admin/InboxList"
import { BotKillSwitch } from "@/components/admin/BotKillSwitch"
import { InboxAvailabilityToggle } from "@/components/admin/InboxAvailabilityToggle"

export const dynamic = "force-dynamic"

export default async function InboxPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))

  let contacts: InboxContact[] = []
  let botEnabled = true
  let configError = ""

  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    configError = "El inbox no está configurado. Completá AI_TENANT_ID y AI_API_URL en la config del tenant."
  } else {
    const tenantRef = { id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId }
    try {
      // Levanta de la cola las conversaciones derivadas sin operador y les asigna el
      // menos cargado del depto antes de listar. Best-effort (no rompe el inbox). ADR 0006.
      // Reutilizamos las conversaciones que trajo la reconciliación para no re-consultarlas.
      const convs = await assignPendingConversations(tenantRef)
      contacts = await listEnrichedContacts(tenantRef, "active", convs)
      botEnabled = await getBotStatus(tenant.aiApiUrl, tenant.aiTenantId)
    } catch {
      configError = "No se pudo conectar con la API. Verificá la configuración."
    }
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 md:mb-6 flex items-center md:items-start justify-between gap-3 flex-wrap">
        {/* En mobile, el botón de menú (hamburguesa) del SideNav va absolute en left-3 top-3.
            Le dejamos lugar al título para que no quede tapado por el ícono. */}
        <div className="pl-11 md:pl-0">
          <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Inbox</h1>
          {/* El subtítulo es contexto redundante y ocupa alto valioso en mobile: solo en desktop. */}
          <p className="hidden md:block text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>Conversaciones de los canales de mensajería</p>
        </div>
        {/* Presencia + kill switch en la misma fila que el título (evita una fila extra en mobile).
            El toggle "Disponible" lo monta la página en el inbox; el AdminShell no lo repite acá. */}
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <InboxAvailabilityToggle />
          {/* Kill switch global del bot: visible para todos los usuarios del backoffice (sin gate de rol). */}
          {!configError && <BotKillSwitch initialEnabled={botEnabled} />}
        </div>
      </div>

      {configError ? (
        <div className="rounded-[var(--radius)] p-4 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          {configError}
        </div>
      ) : (
        <InboxList initialContacts={contacts} currentUserId={session.userId} initialBotEnabled={botEnabled} />
      )}
    </div>
  )
}
