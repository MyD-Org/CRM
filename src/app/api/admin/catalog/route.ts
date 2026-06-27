import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq, and } from "drizzle-orm"
import { getDb } from "@/db"
import { priceLists, catalogItems } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

async function getSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

// GET /api/admin/catalog — lista todas las price_lists del tenant con conteo de items
export async function GET() {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const db = getDb()
  const lists = await db
    .select()
    .from(priceLists)
    .where(eq(priceLists.tenantId, session.tenantId))
    .orderBy(priceLists.createdAt)

  // Conteo de items por lista
  const counts = await Promise.all(
    lists.map(async (l) => {
      const items = await db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(eq(catalogItems.priceListId, l.id))
      return { id: l.id, count: items.length }
    }),
  )

  const countMap = Object.fromEntries(counts.map((c) => [c.id, c.count]))
  const result = lists.map((l) => ({ ...l, itemCount: countMap[l.id] ?? 0 }))

  return NextResponse.json(result)
}
