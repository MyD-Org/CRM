import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

// Singleton lazy: en dev Next recarga módulos, globalThis evita agotar conexiones.
// `prepare: false` para compatibilidad con poolers (Neon/pgbouncer) en prod.
const globalForDb = globalThis as unknown as { crmDb?: ReturnType<typeof buildDb> }

function buildDb() {
  const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/crm"
  const client = postgres(url, {
    prepare: false,
    // Neon cobra el tiempo que el compute está despierto, y sólo autosuspende
    // tras ~5 min SIN conexiones abiertas. El default de postgres-js es
    // idle_timeout=null (no cerrar nunca), así que una instancia tibia de Vercel
    // mantenía el compute prendido sin hacer una sola query. Cerramos a los 20s.
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  })
  return drizzle(client, { schema })
}

export function getDb() {
  if (!globalForDb.crmDb) globalForDb.crmDb = buildDb()
  return globalForDb.crmDb
}

export type Db = ReturnType<typeof getDb>
