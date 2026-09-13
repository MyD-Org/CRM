import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { eq } from "drizzle-orm"
import { readFileSync } from "node:fs"
import postgres from "postgres"
import { getDb } from "@/db"
import { adminUsers, paymentReceipts } from "@/db/schema"
import { seedOperator, seedTenant, truncateAll } from "./helpers"

/**
 * Modelo de datos de comprobantes de pago (migración 0023), contra Postgres real.
 *
 * El global-setup ya aplicó 0023 vía drizzle migrate; acá se vuelve a aplicar el SQL CRUDO
 * dos veces para probar idempotencia (toda la migración es IF NOT EXISTS / aditiva), y se
 * ejercitan los CHECKs y el ON DELETE SET NULL con inserts reales.
 *
 * Nada de datos reales: tenants tenant-a/tenant-b, mails @example.com, valores inventados.
 */

const MIGRATION_SQL = readFileSync("drizzle/0023_payment_receipts.sql", "utf8")

/** Aplica el SQL de la migración tal cual está en el archivo, sin el tracking de drizzle. */
async function applyRawMigration(): Promise<void> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    await client.unsafe(MIGRATION_SQL)
  } finally {
    await client.end()
  }
}

/** Valores mínimos que pasan todos los CHECKs para un comprobante publicado ('loaded'). */
type ReceiptInsert = typeof paymentReceipts.$inferInsert
function receiptCargado(tenantId: string, overrides: Partial<ReceiptInsert> = {}): ReceiptInsert {
  return {
    tenantId,
    codigocliente: "CLI-001",
    razonsocial: "Cliente de Ejemplo S.A.",
    cuit: "30-71234567-8",
    clientEmail: "cliente@example.com",
    amount: "1500.00",
    paidOn: "2026-09-01",
    method: "transferencia",
    declaredContentType: "application/pdf",
    declaredSize: 12345,
    status: "loaded",
    fileKey: "receipts/tenant-a/2026-09/11111111-2222-3333-4444-555555555555.pdf",
    fileMime: "application/pdf",
    fileSize: 12345,
    fileOriginalName: "comprobante.pdf",
    fileSha256: "a".repeat(64),
    submittedAt: new Date("2026-09-01T12:00:00Z"),
    loadedAt: new Date("2026-09-02T10:00:00Z"),
    ...overrides,
  }
}

describe("migración 0023: payment_receipts (DB real)", () => {
  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await truncateAll()
  })

  it("es idempotente: aplicar el SQL dos veces no falla", async () => {
    await expect(applyRawMigration()).resolves.toBeUndefined()
    await expect(applyRawMigration()).resolves.toBeUndefined()
  })

  it("rechaza un status fuera de la máquina de estados", async () => {
    const tenant = await seedTenant("tenant-a")
    await expect(
      getDb()
        .insert(paymentReceipts)
        .values(
          receiptCargado(tenant, {
            status: "aprobado", // no existe: uploading, processing, pending, loaded, rejected
          }),
        ),
    ).rejects.toThrow()
  })

  it("rechaza amount = 0", async () => {
    const tenant = await seedTenant("tenant-a")
    await expect(
      getDb()
        .insert(paymentReceipts)
        .values(receiptCargado(tenant, { amount: "0.00" })),
    ).rejects.toThrow()
  })

  it("un comprobante válido inserta y lee amount como string", async () => {
    const tenant = await seedTenant("tenant-a")
    const [row] = await getDb()
      .insert(paymentReceipts)
      .values(receiptCargado(tenant))
      .returning()
    expect(row.status).toBe("loaded")
    expect(row.amount).toBe("1500.00")
    expect(row.currency).toBe("ARS")
  })

  it("borrar el admin que lo cargó deja loaded_by en NULL y conserva loaded_by_name", async () => {
    const tenant = await seedTenant("tenant-a")
    const adminId = await seedOperator(tenant, {
      name: "Ana Admin",
      role: "admin",
      email: "ana.admin@example.com",
    })
    const [inserted] = await getDb()
      .insert(paymentReceipts)
      .values(
        receiptCargado(tenant, {
          loadedBy: adminId,
          loadedByName: "Ana Admin",
        }),
      )
      .returning({ id: paymentReceipts.id })
    expect(inserted).toBeDefined()

    await getDb().delete(adminUsers).where(eq(adminUsers.id, adminId))

    const [row] = await getDb()
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, inserted.id))
    expect(row.loadedBy).toBeNull()
    expect(row.loadedByName).toBe("Ana Admin")
  })
})
