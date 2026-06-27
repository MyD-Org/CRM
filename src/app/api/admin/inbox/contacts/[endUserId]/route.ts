import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getContact } from "@/lib/inbox-api"
import { operatorNamesByIds } from "@/lib/operator-names"

export async function GET(_req: Request, { params }: { params: Promise<{ endUserId: string }> }) {
  const { endUserId } = await params
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  let contact
  try {
    contact = await getContact(tenant.aiApiUrl, tenant.aiTenantId, endUserId)
  } catch {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 })
  }

  const nameById = await operatorNamesByIds([contact.assigned_operator_id])
  return NextResponse.json({
    ...contact,
    assigned_operator_name: contact.assigned_operator_id ? nameById.get(contact.assigned_operator_id) ?? null : null,
  })
}
