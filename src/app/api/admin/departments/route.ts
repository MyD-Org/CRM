import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { asc, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { departments } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"

// Catálogo de departamentos del tenant, usado por el select del alta/edición de usuarios.
// Antes estaba hardcodeado en UserList.tsx; ahora vive en la tabla `departments` para que
// sea configurable por tenant y compartible con ai-api (ver /api/internal/departments).
export async function GET() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (!session.userId) return NextResponse.json({ error: "no autorizado" }, { status: 401 })

  const rows = await getDb()
    .select({ key: departments.key, label: departments.label })
    .from(departments)
    .where(eq(departments.tenantId, session.tenantId))
    .orderBy(asc(departments.label))

  return NextResponse.json(rows)
}
