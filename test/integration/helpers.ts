import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { getDb } from "@/db"
import { tenants, adminUsers } from "@/db/schema"
import { assertLocalTestDb } from "./db-url"

// Helpers compartidos por los tests de integración: siembran datos mínimos (tenant, operador)
// y limpian las tablas entre tests. getDb() usa process.env.DATABASE_URL, que el proyecto
// "integration" de vitest apunta a la DB de test.

// Doble chequeo de seguridad antes de truncar: nunca contra una DB que no sea local de test.
function guard() {
  assertLocalTestDb(process.env.DATABASE_URL || "")
}

/** Vacía las tablas que tocan los tests. CASCADE limpia también las que referencian por FK. */
export async function truncateAll(): Promise<void> {
  guard()
  await getDb().execute(
    sql`truncate table ${tenants}, ${adminUsers}, conversation_assignments, push_subscriptions restart identity cascade`,
  )
}

export async function seedTenant(id = "test-tenant"): Promise<string> {
  guard()
  await getDb()
    .insert(tenants)
    .values({
      id,
      name: "Tenant de Test",
      logoPath: "/logos/test.svg",
      resendFrom: "test@example.com",
      aiTenantId: `ai-${id}`,
    })
    .onConflictDoNothing()
  return id
}

export async function seedOperator(
  tenantId: string,
  opts: { name?: string; email?: string; departments?: string[]; availability?: "available" | "away" } = {},
): Promise<string> {
  guard()
  const id = randomUUID()
  await getDb()
    .insert(adminUsers)
    .values({
      id,
      tenantId,
      email: opts.email ?? `op-${id}@example.com`,
      name: opts.name ?? "Operador",
      departments: opts.departments ?? [],
      availability: opts.availability ?? "away",
      passwordHash: "x", // cuenta "activa" (passwordHash != null)
    })
  return id
}
