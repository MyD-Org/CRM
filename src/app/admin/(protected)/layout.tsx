import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getTenantByIdFromDb } from "@/lib/tenants"
import { AdminShell } from "@/components/admin/AdminShell"

export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) redirect("/admin/login")

  const tenant = session.tenantId ? await getTenantByIdFromDb(session.tenantId) : null

  return (
    <AdminShell name={session.name} role={session.role} logoSrc={tenant?.logoPath} tenantName={tenant?.name}>
      {children}
    </AdminShell>
  )
}
