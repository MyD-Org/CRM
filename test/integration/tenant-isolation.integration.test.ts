import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { hashPassword, verifyPassword } from "@/lib/admin-crypto"
import { seedTenant, truncateAll } from "./helpers"

/**
 * Aislamiento entre tenants a nivel de DATOS, contra Postgres real.
 *
 * Los unit tests cubren la lógica de resolución con la DB mockeada; esto verifica que las
 * queries que sostienen el aislamiento realmente filtren, con el schema y los constraints
 * de verdad — incluido el índice único de email, que es lo que la Entrega B va a cambiar.
 *
 * NO se usa `seedOperator()` de los helpers: siembra `passwordHash: "x"`, que no es un hash
 * válido. `verifyPassword` hace `stored.split(":")` y devuelve false SIN correr scrypt, así
 * que cualquier test de login construido sobre ese helper pasa sin ejercitar nada.
 */

const PASSWORD = "una-password-de-prueba-123"

/** Siembra un admin con hash REAL, a diferencia de `seedOperator()`. */
async function seedAdminConPassword(tenantId: string, email: string) {
  const [row] = await getDb()
    .insert(adminUsers)
    .values({
      tenantId,
      email,
      name: `Admin de ${tenantId}`,
      role: "superadmin",
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning({ id: adminUsers.id })
  return row.id
}

/** La query exacta del login: email AND tenant del host. */
function buscarParaLogin(email: string, tenantId: string) {
  return getDb()
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.email, email), eq(adminUsers.tenantId, tenantId)))
}

describe("aislamiento entre tenants (DB real)", () => {
  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await truncateAll()
  })

  it("la query del login no encuentra al admin de un tenant desde otro", async () => {
    const a = await seedTenant("tenant-a")
    const b = await seedTenant("tenant-b")
    await seedAdminConPassword(a, "admin-a@example.com")

    const enSuTenant = await buscarParaLogin("admin-a@example.com", a)
    expect(enSuTenant).toHaveLength(1)

    // El mismo email, la misma password, pero pidiendo desde el otro tenant: no existe.
    const enElOtro = await buscarParaLogin("admin-a@example.com", b)
    expect(enElOtro).toHaveLength(0)
  })

  it("la password es válida solo dentro de su tenant", async () => {
    const a = await seedTenant("tenant-a")
    await seedTenant("tenant-b")
    await seedAdminConPassword(a, "admin-a@example.com")

    const [user] = await buscarParaLogin("admin-a@example.com", a)
    // Sanity: el hash sembrado es real y scrypt lo valida (si fuera "x" esto daría false
    // sin llegar a correr scrypt, y el test no probaría nada).
    expect(await verifyPassword(PASSWORD, user.passwordHash!)).toBe(true)
    expect(await verifyPassword("password-incorrecta", user.passwordHash!)).toBe(false)
  })

  it("una invitación pendiente (password_hash NULL) no es una cuenta activa", async () => {
    const a = await seedTenant("tenant-a")
    await getDb().insert(adminUsers).values({
      tenantId: a,
      email: "invitado@example.com",
      name: "Invitado",
      role: "operator",
      // sin passwordHash: invitación aceptada todavía no
    })

    const [user] = await buscarParaLogin("invitado@example.com", a)
    expect(user).toBeDefined()
    expect(user.passwordHash).toBeNull()
  })

  it("la query de assign no encuentra un operador de otro tenant", async () => {
    const a = await seedTenant("tenant-a")
    const b = await seedTenant("tenant-b")
    const operadorDeB = await seedAdminConPassword(b, "op-b@example.com")

    // Un operador de A manda el UUID de un operador de B (el IDOR).
    const [encontrado] = await getDb()
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(and(eq(adminUsers.id, operadorDeB), eq(adminUsers.tenantId, a)))

    expect(encontrado).toBeUndefined()

    // Control: desde su propio tenant sí aparece, o el test pasaría por la razón equivocada.
    const [propio] = await getDb()
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(and(eq(adminUsers.id, operadorDeB), eq(adminUsers.tenantId, b)))
    expect(propio?.id).toBe(operadorDeB)
  })

  it("el índice único de email es GLOBAL, no por tenant (pendiente Entrega B)", async () => {
    const a = await seedTenant("tenant-a")
    const b = await seedTenant("tenant-b")
    await seedAdminConPassword(a, "misma@example.com")

    // Documenta el estado ACTUAL: la misma persona no puede tener cuenta en dos tenants.
    // La Entrega B cambia el índice a (email, tenant_id) y este test se invierte.
    await expect(seedAdminConPassword(b, "misma@example.com")).rejects.toThrow()
  })

  it.todo("misma persona con cuentas independientes en dos tenants — requiere Entrega B")
})
