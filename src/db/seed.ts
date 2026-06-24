import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { tenants, clientCommercialConditions, notificationRules, adminUsers } from "./schema"
import { mockCondiciones } from "../lib/mock-data"
import { hashPassword } from "../lib/admin-crypto"

// Seed idempotente: upsert por clave, se puede correr múltiples veces.
// Lee los valores sensibles desde env en runtime — no hardcodear acá.

async function main() {
  const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/crm"
  const client = postgres(url, { max: 1 })
  const db = drizzle(client)

  try {
    const tenantId = "central-led"
    const prefix = "CENTRAL_LED"

    const tenantRow = {
      id: tenantId,
      name: process.env[`${prefix}_NAME`] ?? "Central LED",
      subtitle: process.env[`${prefix}_SUBTITLE`] ?? "",
      logoPath: process.env[`${prefix}_LOGO`] ?? `/logos/${tenantId}.svg`,
      flexxusBaseUrl: process.env[`${prefix}_FLEXXUS_URL`] ?? "",
      flexxusToken: process.env[`${prefix}_FLEXXUS_TOKEN`] ?? "",
      flexxusMock: process.env[`${prefix}_MOCK`] === "true",
      whatsappNumber: process.env[`${prefix}_WHATSAPP`] ?? "",
      resendFrom: process.env[`${prefix}_RESEND_FROM`] ?? "portal@example.com",
      aiApiUrl: process.env[`${prefix}_AI_API_URL`] ?? "",
      aiApiKey: process.env[`${prefix}_AI_API_KEY`] ?? "",
      aiAgentId: process.env[`${prefix}_AI_AGENT_ID`] ?? "",
      aiTenantId: process.env[`${prefix}_AI_TENANT_ID`] ?? "",
      updatedAt: new Date(),
    }

    await db
      .insert(tenants)
      .values(tenantRow)
      .onConflictDoUpdate({ target: tenants.id, set: tenantRow })
    console.log(`tenant "${tenantId}" upserted`)

    const condicionesRow = {
      tenantId,
      codigocliente: "CLI001",
      condicionPago: mockCondiciones.condicionPago,
      plazoDias: mockCondiciones.plazoDias,
      listaPrecios: mockCondiciones.listaPrecios,
      descuentos: mockCondiciones.descuentos,
      vendedor: mockCondiciones.vendedor,
      transporte: mockCondiciones.transporte,
      updatedAt: new Date(),
    }

    await db
      .insert(clientCommercialConditions)
      .values(condicionesRow)
      .onConflictDoUpdate({
        target: [clientCommercialConditions.tenantId, clientCommercialConditions.codigocliente],
        set: condicionesRow,
      })
    console.log(`condiciones comerciales CLI001 upserted`)

    await db
      .insert(notificationRules)
      .values({ tenantId })
      .onConflictDoNothing({ target: notificationRules.tenantId })
    console.log(`notification rules para "${tenantId}" ok (defaults: before [3,1], after [1,7,15], email)`)

    // Superadmin inicial — solo se crea si no existe ningún admin para este tenant.
    const adminEmail = process.env.ADMIN_EMAIL
    const adminPassword = process.env.ADMIN_PASSWORD
    if (adminEmail && adminPassword) {
      const existing = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, adminEmail))
      if (!existing.length) {
        const passwordHash = await hashPassword(adminPassword)
        await db.insert(adminUsers).values({
          tenantId,
          email: adminEmail,
          name: process.env.ADMIN_NAME ?? "Superadmin",
          role: "superadmin",
          passwordHash,
        })
        console.log(`superadmin "${adminEmail}" creado`)
      } else {
        console.log(`superadmin "${adminEmail}" ya existe, omitido`)
      }
    } else {
      console.log("ADMIN_EMAIL / ADMIN_PASSWORD no definidos — superadmin no creado")
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
