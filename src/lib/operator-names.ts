import { eq, inArray } from "drizzle-orm"
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

// Todos los nombres de operadores del tenant. Sirve para arrancar la consulta ANTES de saber
// qué operador nos va a interesar (ver la vista de conversación, que resolvía el nombre en un
// round-trip extra al final de la cascada). La tabla es chica: un puñado de filas por tenant.
export async function operatorNamesByTenant(tenantId: string): Promise<Map<string, string>> {
  const ops = await getDb()
    .select({ id: adminUsers.id, name: adminUsers.name })
    .from(adminUsers)
    .where(eq(adminUsers.tenantId, tenantId))
  return new Map(ops.map((op) => [op.id, op.name]))
}
