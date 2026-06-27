import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { priceLists, catalogItems } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { parsePriceListExcel } from "@/lib/price-list-parser"

async function getSession() {
  return getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
}

// POST /api/admin/catalog/upload
// Body: multipart/form-data con campos: name, category, file (xlsx)
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const formData = await req.formData()
  const name = String(formData.get("name") ?? "").trim()
  const category = String(formData.get("category") ?? "").trim()
  const file = formData.get("file") as File | null

  if (!name || !category) {
    return NextResponse.json({ error: "nombre y categoría son obligatorios" }, { status: 400 })
  }
  if (!file) {
    return NextResponse.json({ error: "archivo requerido" }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const { columns, items, errors } = parsePriceListExcel(buffer)

  if (items.length === 0) {
    return NextResponse.json({ error: "No se encontraron productos en el archivo", details: errors }, { status: 400 })
  }

  const db = getDb()

  // Desactivar lista anterior de la misma categoría
  await db
    .update(priceLists)
    .set({ active: false })
    .where(eq(priceLists.tenantId, session.tenantId))

  const [list] = await db
    .insert(priceLists)
    .values({
      tenantId: session.tenantId,
      name,
      category,
      priceColumns: columns,
      fileData: buffer,
      fileName: file.name,
      active: true,
    })
    .returning()

  // Insertar items en lotes de 500
  const BATCH = 500
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH).map((item) => ({
      priceListId: list.id,
      tenantId: session.tenantId,
      code: item.code,
      description: item.description,
      prices: item.prices,
    }))
    await db.insert(catalogItems).values(batch)
  }

  return NextResponse.json({
    id: list.id,
    name: list.name,
    category: list.category,
    columns,
    itemCount: items.length,
    parseErrors: errors,
  })
}
