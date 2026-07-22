import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { pushSubscriptions, adminUsers } from "@/db/schema"
import { seedTenant, seedOperator, truncateAll } from "./helpers"

// Tests de integración de la tabla de suscripciones push contra la DB real (crm_test).
// Verifican el upsert por endpoint (mismo browser re-suscribiéndose) y el borrado en cascada
// al eliminar el operador — la lógica que usan /api/admin/push/subscribe y el envío.

async function upsertSubscription(
  tenantId: string,
  operatorId: string,
  endpoint: string,
  keys: { p256dh: string; auth: string },
) {
  await getDb()
    .insert(pushSubscriptions)
    .values({ tenantId, operatorId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { tenantId, operatorId, p256dh: keys.p256dh, auth: keys.auth, lastUsedAt: new Date() },
    })
}

describe("push_subscriptions (DB)", () => {
  let tenant: string
  let op1: string
  let op2: string

  beforeEach(async () => {
    await truncateAll()
    tenant = await seedTenant()
    op1 = await seedOperator(tenant, { name: "Op Uno" })
    op2 = await seedOperator(tenant, { name: "Op Dos" })
  })

  it("guarda una suscripción del operador", async () => {
    await upsertSubscription(tenant, op1, "https://push.example/abc", { p256dh: "k1", auth: "a1" })
    const rows = await getDb().select().from(pushSubscriptions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ operatorId: op1, endpoint: "https://push.example/abc", p256dh: "k1" })
  })

  it("re-suscribir el mismo endpoint hace upsert (no duplica) y actualiza claves/dueño", async () => {
    await upsertSubscription(tenant, op1, "https://push.example/abc", { p256dh: "k1", auth: "a1" })
    await upsertSubscription(tenant, op2, "https://push.example/abc", { p256dh: "k2", auth: "a2" })
    const rows = await getDb().select().from(pushSubscriptions)
    expect(rows).toHaveLength(1) // unique(endpoint) → una sola fila
    expect(rows[0].operatorId).toBe(op2)
    expect(rows[0].p256dh).toBe("k2")
  })

  it("permite varias suscripciones por operador (varios dispositivos)", async () => {
    await upsertSubscription(tenant, op1, "https://push.example/dev1", { p256dh: "k1", auth: "a1" })
    await upsertSubscription(tenant, op1, "https://push.example/dev2", { p256dh: "k2", auth: "a2" })
    const rows = await getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.operatorId, op1))
    expect(rows).toHaveLength(2)
  })

  it("borra las suscripciones en cascada al eliminar el operador", async () => {
    await upsertSubscription(tenant, op1, "https://push.example/abc", { p256dh: "k1", auth: "a1" })
    await getDb().delete(adminUsers).where(eq(adminUsers.id, op1))
    const rows = await getDb().select().from(pushSubscriptions)
    expect(rows).toHaveLength(0) // FK onDelete: cascade
  })
})
