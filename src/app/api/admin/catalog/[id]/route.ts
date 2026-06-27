import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq, and, ilike, or } from "drizzle-orm"
import { getDb } from "@/db"
import { priceLists, catalogItems } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

async function getSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

// GET /api/admin/catalog/[id]?q=... — items de una lista, con búsqueda opcional
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const q = req.nextUrl.searchParams.get("q") ?? ""

  const db = getDb()
  const [list] = await db
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.tenantId, session.tenantId)))

  if (!list) return NextResponse.json({ error: "lista no encontrada" }, { status: 404 })

  const whereClause = q
    ? and(
        eq(catalogItems.priceListId, id),
        or(ilike(catalogItems.description, `%${q}%`), ilike(catalogItems.code, `%${q}%`)),
      )
    : eq(catalogItems.priceListId, id)

  const items = await db.select().from(catalogItems).where(whereClause).limit(100)

  return NextResponse.json({ list, items })
}

// DELETE /api/admin/catalog/[id] — elimina una lista y sus items (cascade en DB)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const db = getDb()

  const [deleted] = await db
    .delete(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.tenantId, session.tenantId)))
    .returning()

  if (!deleted) return NextResponse.json({ error: "lista no encontrada" }, { status: 404 })

  return NextResponse.json({ ok: true })
}
