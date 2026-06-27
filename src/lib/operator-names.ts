import { inArray } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"

// ai-api solo guarda el UUID opaco del operador. Resolvemos los nombres acá, contra
// admin_users del propio CRM, para mostrar "Asignado a {nombre}" en el inbox.
export async function operatorNamesByIds(
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  const map = new Map<string, string>()
  if (!unique.length) return map
  const ops = await getDb()
    .select({ id: adminUsers.id, name: adminUsers.name })
    .from(adminUsers)
    .where(inArray(adminUsers.id, unique))
  for (const op of ops) map.set(op.id, op.name)
  return map
}
