import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getContactMessages } from "@/lib/inbox-api"

export async function GET(req: Request, { params }: { params: Promise<{ endUserId: string }> }) {
  const { endUserId } = await params
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))
  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    return NextResponse.json({ error: "inbox no configurado" }, { status: 503 })
  }

  const sp = new URL(req.url).searchParams
  const before = sp.get("before")
  const limit = sp.get("limit")

  try {
    const page = await getContactMessages(tenant.aiApiUrl, tenant.aiTenantId, endUserId, {
      before: before ? Number(before) : undefined,
      limit: limit ? Number(limit) : undefined,
    })
    return NextResponse.json(page)
  } catch {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 })
  }
}
