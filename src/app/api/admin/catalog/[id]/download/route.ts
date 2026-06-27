import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { priceLists } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const { id } = await params
  const db = getDb()

  const [list] = await db
    .select({ fileData: priceLists.fileData, fileName: priceLists.fileName })
    .from(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.tenantId, session.tenantId)))

  if (!list?.fileData) return NextResponse.json({ error: "archivo no disponible" }, { status: 404 })

  return new NextResponse(list.fileData as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${list.fileName ?? "lista-precios.xlsx"}"`,
    },
  })
}
