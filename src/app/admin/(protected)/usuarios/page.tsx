import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { adminUsers, adminPasswordTokens } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { UserList } from "@/components/admin/UserList"

export const dynamic = "force-dynamic"

export default async function UsuariosPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (session.role !== "superadmin") notFound()

  const users = await getDb()
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      role: adminUsers.role,
      department: adminUsers.department,
      createdAt: adminUsers.createdAt,
      passwordHash: adminUsers.passwordHash,
      inviteExpiresAt: adminPasswordTokens.expiresAt,
      inviteAcceptedAt: adminPasswordTokens.usedAt,
    })
    .from(adminUsers)
    .leftJoin(
      adminPasswordTokens,
      and(eq(adminPasswordTokens.userId, adminUsers.id), eq(adminPasswordTokens.type, "invite")),
    )
    .where(eq(adminUsers.tenantId, session.tenantId))

  const userList = users.map((u) => ({ ...u, hasPassword: !!u.passwordHash, passwordHash: undefined }))

  return (
    <div className="p-4 md:p-6">
      <UserList initialUsers={userList} currentUserId={session.userId} currentRole={session.role} />
    </div>
  )
}
