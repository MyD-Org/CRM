import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { listContacts, getBotStatus } from "@/lib/inbox-api"
import { assignPendingConversations } from "@/lib/assignment"
import { botKillSwitchVisible } from "@/lib/flags"
import { InboxList } from "@/components/admin/InboxList"
import { BotKillSwitch } from "@/components/admin/BotKillSwitch"

export const dynamic = "force-dynamic"

export default async function InboxPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))

  let contacts: Awaited<ReturnType<typeof listContacts>> = []
  let botEnabled = true
  let configError = ""

  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    configError = "El inbox no está configurado. Completá AI_TENANT_ID y AI_API_URL en la config del tenant."
  } else {
    try {
      // Levanta de la cola las conversaciones derivadas sin operador y les asigna el
      // menos cargado del depto antes de listar. Best-effort (no rompe el inbox). ADR 0006.
      await assignPendingConversations({ id: tenant.id, aiApiUrl: tenant.aiApiUrl, aiTenantId: tenant.aiTenantId })
      contacts = await listContacts(tenant.aiApiUrl, tenant.aiTenantId, "active")
      botEnabled = await getBotStatus(tenant.aiApiUrl, tenant.aiTenantId)
    } catch {
      configError = "No se pudo conectar con la API. Verificá la configuración."
    }
  }

  const showBotSwitch = await botKillSwitchVisible()

  return (
    <div className="p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Inbox</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>Conversaciones de los canales de mensajería</p>
        </div>
        {!configError && showBotSwitch && <BotKillSwitch initialEnabled={botEnabled} />}
      </div>

      {configError ? (
        <div className="rounded-[var(--radius)] p-4 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          {configError}
        </div>
      ) : (
        <InboxList initialContacts={contacts} currentUserId={session.userId} />
      )}
    </div>
  )
}
