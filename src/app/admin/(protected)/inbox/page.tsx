import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { listConversations } from "@/lib/inbox-api"
import { InboxList } from "@/components/admin/InboxList"

export const dynamic = "force-dynamic"

export default async function InboxPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))

  let conversations: Awaited<ReturnType<typeof listConversations>> = []
  let configError = ""

  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    configError = "El inbox no está configurado. Completá AI_TENANT_ID y AI_API_URL en la config del tenant."
  } else {
    try {
      conversations = await listConversations(tenant.aiApiUrl, tenant.aiTenantId)
    } catch {
      configError = "No se pudo conectar con la API. Verificá la configuración."
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Inbox</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>Conversaciones de WhatsApp del canal</p>
      </div>

      {configError ? (
        <div className="rounded-[var(--radius)] p-4 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          {configError}
        </div>
      ) : (
        <InboxList initialConversations={conversations} />
      )}
    </div>
  )
}
