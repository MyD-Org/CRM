import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

// Singleton lazy: en dev Next recarga módulos, globalThis evita agotar conexiones.
// `prepare: false` para compatibilidad con poolers (Neon/pgbouncer) en prod.
const globalForDb = globalThis as unknown as { crmDb?: ReturnType<typeof buildDb> }

function buildDb() {
  const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/crm"
  const client = postgres(url, { prepare: false })
  return drizzle(client, { schema })
}

export function getDb() {
  if (!globalForDb.crmDb) globalForDb.crmDb = buildDb()
  return globalForDb.crmDb
}

export type Db = ReturnType<typeof getDb>
