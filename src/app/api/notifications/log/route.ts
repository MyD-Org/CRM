import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { desc, eq, and, inArray, isNull } from "drizzle-orm"
import { getDb } from "@/db"
import { notificationLog } from "@/db/schema"
import { sessionOptions } from "@/lib/session"
import { getTenantConfig } from "@/lib/tenant-context"
import type { SessionData } from "@/types"

export async function GET() {
  const [tenant, cookieStore] = await Promise.all([getTenantConfig(), cookies()])
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const rows = await getDb()
    .select()
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.tenantId, tenant.id),
        eq(notificationLog.codigocliente, session.codigocliente),
      ),
    )
    .orderBy(desc(notificationLog.sentAt))
    .limit(50)

  return Response.json(rows)
}

// Marca notificaciones como leídas. Body: { ids: string[] } o { all: true }.
export async function PATCH(req: Request) {
  const [tenant, cookieStore] = await Promise.all([getTenantConfig(), cookies()])
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn || !session.codigocliente) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean }
  // Scope siempre acotado al cliente logueado: nadie marca notifs de otro.
  const scope = and(
    eq(notificationLog.tenantId, tenant.id),
    eq(notificationLog.codigocliente, session.codigocliente),
  )

  if (body.all) {
    await getDb()
      .update(notificationLog)
      .set({ readAt: new Date() })
      .where(and(scope, isNull(notificationLog.readAt)))
    return Response.json({ ok: true })
  }

  if (body.ids?.length) {
    await getDb()
      .update(notificationLog)
      .set({ readAt: new Date() })
      .where(and(scope, inArray(notificationLog.id, body.ids)))
    return Response.json({ ok: true })
  }

  return Response.json({ error: "nada para marcar" }, { status: 400 })
}
