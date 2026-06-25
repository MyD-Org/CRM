import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { listConversations, getMessages } from "@/lib/inbox-api"
import { ThreadView } from "@/components/admin/ThreadView"

export const dynamic = "force-dynamic"

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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

  const [conversations, messages] = await Promise.all([
    listConversations(tenant.aiApiUrl, tenant.aiTenantId),
    getMessages(tenant.aiApiUrl, tenant.aiTenantId, id).catch(() => null),
  ])

  const conversation = conversations.find((c) => c.id === id)
  if (!conversation || messages === null) notFound()

  return (
    <ThreadView
      conversation={conversation}
      initialMessages={messages}
      currentUserId={session.userId}
    />
  )
}
