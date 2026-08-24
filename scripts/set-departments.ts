/**
 * Carga el catálogo de departamentos de un tenant. No hay pantalla para esto: el endpoint
 * /api/admin/departments es solo GET, así que el catálogo se siembra desde acá.
 *
 *   CRM_DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.prod | head -1 | tr -d '"')" \
 *     npx tsx scripts/set-departments.ts tevro administracion:Administración taller:Taller
 *
 * Cada argumento es key:Label. La `key` es el slug estable que se guarda en
 * admin_users.departments y en conversation_assignments.department; el label se puede
 * renombrar después sin migrar nada. Es idempotente: si la key ya existe, actualiza el label.
 *
 * CRM_DATABASE_URL manda sobre DATABASE_URL porque --env-file no pisa lo que ya está
 * exportado en el shell (ver set-tenant-alegra.ts).
 */
import { and, eq, sql } from "drizzle-orm"
import { getDb } from "../src/db"
import { departments, tenants } from "../src/db/schema"

if (process.env.CRM_DATABASE_URL) process.env.DATABASE_URL = process.env.CRM_DATABASE_URL

async function main() {
  const [tenantId, ...pares] = process.argv.slice(2)
  if (!tenantId || pares.length === 0) {
    console.error("Uso: ... scripts/set-departments.ts <tenant-id> <key:Label> [key:Label ...]")
    process.exitCode = 1
    return
  }

  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[/?].*$/, "")
  console.log(`base:    ${host || "???"}  (${/localhost|127\.0\.0\.1/.test(host) ? "LOCAL" : "REMOTA"})\n`)

  const db = getDb()
  const [{ existe }] = (await db.execute<{ existe: boolean }>(sql`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'departments' and column_name = 'key'
    ) as existe
  `)) as unknown as { existe: boolean }[]
  if (!existe) {
    console.error("Esta base NO es la del CRM (no tiene departments.key). Revisá CRM_DATABASE_URL.")
    process.exitCode = 1
    return
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
  if (!tenant) {
    console.error(`No existe el tenant "${tenantId}".`)
    process.exitCode = 1
    return
  }

  for (const par of pares) {
    const idx = par.indexOf(":")
    if (idx <= 0) {
      console.error(`Argumento inválido "${par}": tiene que ser key:Label`)
      process.exitCode = 1
      return
    }
    const key = par.slice(0, idx)
    const label = par.slice(idx + 1)
    const [ya] = await db.select().from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.key, key)))
    if (ya) {
      await db.update(departments).set({ label, updatedAt: new Date() }).where(eq(departments.id, ya.id))
      console.log(`  ~ ${key} → "${label}" (ya existía, label actualizado)`)
    } else {
      await db.insert(departments).values({ tenantId, key, label })
      console.log(`  + ${key} → "${label}"`)
    }
  }

  const todos = await db.select().from(departments).where(eq(departments.tenantId, tenantId))
  console.log(`\ncatálogo de ${tenantId}: ${todos.map((d) => d.key).join(", ")}`)
}

main().then(() => process.exit())
