import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { botUsagePanelEnabled } from "@/lib/flags"
import { AdminShell } from "@/components/admin/AdminShell"

export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) redirect("/admin/login")

  const tenant = session.tenantId ? await getTenantByIdFromDb(session.tenantId) : null

  const [me] = await getDb()
    .select({ availability: adminUsers.availability })
    .from(adminUsers)
    .where(eq(adminUsers.id, session.userId))
  const availability = me?.availability === "available" ? "available" : "away"

  const usagePanelEnabled = await botUsagePanelEnabled()

  return (
    <AdminShell
      name={session.name}
      email={session.email}
      role={session.role}
      logoSrc={tenant?.logoPath}
      tenantName={tenant?.name}
      availability={availability}
      currentUserId={session.userId}
      usagePanelEnabled={usagePanelEnabled}
    >
      {children}
    </AdminShell>
  )
}
