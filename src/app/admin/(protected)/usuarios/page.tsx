import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { UserList } from "@/components/admin/UserList"

export const dynamic = "force-dynamic"

export default async function UsuariosPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (session.role !== "superadmin") notFound()

  const users = await getDb()
    .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.role, createdAt: adminUsers.createdAt, passwordHash: adminUsers.passwordHash })
    .from(adminUsers)
    .where(eq(adminUsers.tenantId, session.tenantId))

  const userList = users.map((u) => ({ ...u, hasPassword: !!u.passwordHash, passwordHash: undefined }))

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Usuarios</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>Operadores del backoffice</p>
      </div>
      <UserList initialUsers={userList} currentUserId={session.userId} />
    </div>
  )
}
