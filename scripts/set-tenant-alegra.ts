/**
 * Conecta un tenant a su cuenta REAL de Alegra: copia las credenciales desde las env vars
 * a la fila del tenant y apaga alegraMock.
 *
 * Mientras alegraMock está en true, TODA búsqueda de contactos y productos responde con las
 * fixtures de mock-alegra.ts. No falla ni avisa: devuelve datos de mentira. Eso hacía que el
 * bot de WhatsApp no encontrara a ningún cliente real, ni por nombre ni por teléfono.
 *
 * Las credenciales salen de {PREFIX}_ALEGRA_EMAIL / {PREFIX}_ALEGRA_TOKEN (PREFIX = el id del
 * tenant en mayúsculas, con guiones como guión bajo). Nunca se imprimen.
 *
 *   CRM_DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.prod | head -1 | tr -d '\"')" \\
 *     npx tsx --env-file=.env.local scripts/set-tenant-alegra.ts tevro AVANTEC
 *
 * CRM_DATABASE_URL manda sobre todo lo demás, y existe por un motivo concreto: --env-file NO
 * pisa una variable que ya esté exportada en el shell. Si tenés un DATABASE_URL de otro
 * proyecto en el entorno (pasa fácil trabajando con ai-api al lado), el script se conecta a
 * ESA base sin que se note. Por eso además imprime el host y verifica que el esquema sea el
 * del CRM antes de escribir.
 *
 * El segundo argumento es opcional: sirve cuando el prefijo de las env vars no coincide con
 * el id del tenant (es el caso de tevro, cuyas credenciales están como AVANTEC_*).
 */
import { eq, sql } from "drizzle-orm"
import { getDb } from "../src/db"
import { tenants } from "../src/db/schema"

// getDb() lee DATABASE_URL recién al abrir la conexión, así que basta con sustituirla acá,
// antes de la primera llamada.
if (process.env.CRM_DATABASE_URL) process.env.DATABASE_URL = process.env.CRM_DATABASE_URL

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) {
    console.error("Uso: ... scripts/set-tenant-alegra.ts <tenant-id> [PREFIJO_ENV]")
    process.exitCode = 1
    return
  }
  const prefix = (process.argv[3] ?? tenantId).toUpperCase().replace(/-/g, "_")
  const email = process.env[`${prefix}_ALEGRA_EMAIL`] ?? ""
  const token = process.env[`${prefix}_ALEGRA_TOKEN`] ?? ""
  if (!email || !token) {
    console.error(`Faltan ${prefix}_ALEGRA_EMAIL / ${prefix}_ALEGRA_TOKEN en el env.`)
    process.exitCode = 1
    return
  }

  // A qué base apunta esto, dicho en voz alta: es el error fácil de cometer acá.
  const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[/?].*$/, "")
  const esLocal = /localhost|127\.0\.0\.1/.test(host)
  console.log(`base:    ${host || "???"}  (${esLocal ? "LOCAL" : "REMOTA"})\n`)

  const db = getDb()

  // Que la base sea la del CRM y no la de otro proyecto: ai-api también tiene una tabla
  // "tenants", con otras columnas. Sin este chequeo el error sería un stacktrace de SQL.
  const [{ existe }] = await db.execute<{ existe: boolean }>(sql`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'tenants' and column_name = 'alegra_token'
    ) as existe
  `) as unknown as { existe: boolean }[]
  if (!existe) {
    console.error(`Esta base NO es la del CRM (no tiene tenants.alegra_token). Revisá DATABASE_URL / CRM_DATABASE_URL.`)
    process.exitCode = 1
    return
  }

  const [antes] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
  if (!antes) {
    console.error(`No existe el tenant "${tenantId}".`)
    process.exitCode = 1
    return
  }
  console.log(`antes:   alegraMock=${antes.alegraMock}  email=${antes.alegraEmail ? "SET" : "VACIO"}  token=${antes.alegraToken ? "SET" : "VACIO"}`)

  await db.update(tenants)
    .set({ alegraEmail: email, alegraToken: token, alegraMock: false })
    .where(eq(tenants.id, tenantId))

  const [despues] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
  console.log(`después: alegraMock=${despues.alegraMock}  email=${despues.alegraEmail ? "SET" : "VACIO"}  token=${despues.alegraToken ? "SET" : "VACIO"}`)
  console.log(despues.alegraMock === false && despues.alegraEmail && despues.alegraToken
    ? "\nOK: el tenant ya consulta la cuenta real de Alegra."
    : "\nOJO: quedó algo sin setear.")
}

main().then(() => process.exit())
