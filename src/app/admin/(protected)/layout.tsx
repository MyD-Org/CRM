import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { AdminShell } from "@/components/admin/AdminShell"

export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) redirect("/admin/login")

  return (
    <AdminShell name={session.name} role={session.role}>
      {children}
    </AdminShell>
  )
}
