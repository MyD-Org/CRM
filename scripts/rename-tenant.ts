/**
 * Renombra el id de un tenant, arrastrando todas sus filas.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/rename-tenant.ts tevro avantec
 *   ... --apply     # sin este flag es dry-run: cuenta filas y no escribe nada
 *
 * Por qué un script y no una migración: `tenants.id` es la clave de negocio del tenant y
 * renombrarlo es un movimiento de DATOS de un entorno puntual (prod), no un cambio de schema.
 * Una migración de drizzle correría también en local, en test y en cada preview, donde el
 * tenant viejo no existe.
 *
 * `tenant_id` es un FK de texto SIN `ON UPDATE CASCADE`, así que no alcanza con un UPDATE
 * sobre `tenants`: hay que crear la fila nueva, reapuntar los hijos y recién ahí borrar la
 * vieja. Todo en UNA transacción — a mitad de camino la base queda con dos tenants y las
 * conversaciones repartidas entre los dos.
 *
 * Las tablas hijas NO están hardcodeadas: se descubren en `information_schema` por su FK a
 * `tenants`. Una tabla nueva se arrastra sola sin tocar este script.
 *
 * Después de correrlo:
 *  - Las sesiones de `/admin` del tenant viejo llevan el id viejo en la cookie. El guard falla
 *    cerrado y los operadores vuelven a loguearse. Es lo esperado, no un bug.
 *  - Si el tenant tenía dominio propio, revisar la columna `domains` y el DNS.
 *  - El registro del proxy se cachea 60s (ver `getTenantRegistry`): la URL vieja puede seguir
 *    respondiendo ese ratito.
 */
import postgres from "postgres"

const [from, to] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const apply = process.argv.includes("--apply")

if (!from || !to) {
  console.error("uso: rename-tenant.ts <id-viejo> <id-nuevo> [--apply]")
  process.exit(1)
}

const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/crm"
const sql = postgres(url, { max: 1 })

async function main() {
  console.log(`DB: ${url.replace(/:[^:@/]*@/, ":***@")}`)
  console.log(`Renombrar tenant "${from}" → "${to}"${apply ? "" : "  (DRY RUN)"}\n`)

  const [existing] = await sql<{ id: string }[]>`SELECT id FROM tenants WHERE id = ${from}`
  if (!existing) throw new Error(`el tenant "${from}" no existe`)

  const [collision] = await sql<{ id: string }[]>`SELECT id FROM tenants WHERE id = ${to}`
  if (collision) throw new Error(`el tenant "${to}" YA existe — abortando para no mezclar datos`)

  // Tablas que referencian tenants(id), descubiertas del catálogo.
  const children = await sql<{ table: string; column: string }[]>`
    SELECT tc.table_name AS table, kcu.column_name AS column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = 'tenants'
      AND ccu.column_name = 'id'
    ORDER BY tc.table_name
  `

  console.log(`${children.length} tablas con FK a tenants:`)
  let total = 0
  for (const { table, column } of children) {
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${sql(table)} WHERE ${sql(column)} = ${from}
    `
    total += Number(count)
    console.log(`  ${table}.${column}: ${count}`)
  }
  console.log(`\ntotal de filas a reapuntar: ${total}`)

  if (!apply) {
    console.log("\nDry run — no se escribió nada. Repetir con --apply.")
    return
  }

  await sql.begin(async (tx) => {
    // Copiar la fila entera sin enumerar columnas: una columna nueva de `tenants` no rompe esto.
    await tx`CREATE TEMP TABLE _tenant_copy ON COMMIT DROP AS SELECT * FROM tenants WHERE id = ${from}`
    await tx`UPDATE _tenant_copy SET id = ${to}`
    await tx`INSERT INTO tenants SELECT * FROM _tenant_copy`

    for (const { table, column } of children) {
      const res = await tx`UPDATE ${tx(table)} SET ${tx(column)} = ${to} WHERE ${tx(column)} = ${from}`
      console.log(`  ${table}.${column} → ${res.count} filas`)
    }

    await tx`DELETE FROM tenants WHERE id = ${from}`
  })

  console.log(`\nListo: "${from}" → "${to}".`)
  console.log("Recordá: las sesiones de /admin del tenant viejo quedan inválidas (hay que re-loguear).")
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => sql.end())
