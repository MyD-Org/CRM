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

  // Las tres son independientes: en serie sumaban 3 round-trips a cada navegación.
  const [tenant, [me], usagePanelEnabled] = await Promise.all([
    session.tenantId ? getTenantByIdFromDb(session.tenantId) : null,
    getDb()
      .select({ availability: adminUsers.availability })
      .from(adminUsers)
      .where(eq(adminUsers.id, session.userId)),
    botUsagePanelEnabled(),
  ])
  const availability = me?.availability === "available" ? "available" : "away"

  return (
    <AdminShell
      name={session.name}
      email={session.email}
      role={session.role}
      logoSrc={tenant?.logoPath}
      // Mismo icono cuadrado que sirve de favicon del tenant (convención en root layout.tsx):
      // /public/logos/<tenant>-icon.svg. Se usa en el rail del sidebar (56px) donde el logo
      // horizontal no entra.
      iconSrc={tenant?.id ? `/logos/${tenant.id}-icon.svg` : undefined}
      tenantName={tenant?.name}
      availability={availability}
      currentUserId={session.userId}
      usagePanelEnabled={usagePanelEnabled}
    >
      {children}
    </AdminShell>
  )
}
