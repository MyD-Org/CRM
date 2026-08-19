import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { tenants, notificationRules, adminUsers } from "./schema"
import { hashPassword } from "../lib/admin-crypto"

// Alta de un tenant en la DB — la config vive en la tabla `tenants`, no en env vars.
// `getTenantByIdFromDb` lee esta fila y solo cae al registro de env si no existe.
//
// Idempotente: upsert por id, se puede correr las veces que haga falta.
//
//   DATABASE_URL="postgres://..." npx tsx src/db/seed-tenant.ts \
//     --id tevro --name Tevro --resend-from portal@tevro.com.ar --mock \
//     --admin-email vos@ejemplo.com --admin-password '...'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main() {
  const id = arg("id")
  if (!id) throw new Error("Falta --id (ej. --id tevro)")

  const url = process.env.DATABASE_URL
  if (!url) throw new Error("Falta DATABASE_URL")

  const client = postgres(url, { max: 1 })
  const db = drizzle(client)

  try {
    const tenantRow = {
      id,
      name: arg("name") ?? id,
      subtitle: arg("subtitle") ?? "",
      logoPath: arg("logo") ?? `/logos/${id}.svg`,
      alegraEmail: arg("alegra-email") ?? "",
      alegraToken: arg("alegra-token") ?? "",
      // Sin token de Alegra el portal necesita fixtures, si no queda sin datos que mostrar.
      alegraMock: flag("mock") || !arg("alegra-token"),
      whatsappNumber: arg("whatsapp") ?? "",
      resendFrom: arg("resend-from") ?? `portal@${id}.com`,
      aiApiUrl: arg("ai-api-url") ?? "",
      aiApiKey: arg("ai-api-key") ?? "",
      aiAgentId: arg("ai-agent-id") ?? "",
      aiTenantId: arg("ai-tenant-id") ?? "",
      updatedAt: new Date(),
    }

    await db.insert(tenants).values(tenantRow).onConflictDoUpdate({ target: tenants.id, set: tenantRow })
    console.log(`tenant "${id}" upserted`)

    await db
      .insert(notificationRules)
      .values({ tenantId: id })
      .onConflictDoNothing({ target: notificationRules.tenantId })
    console.log(`notification rules para "${id}" ok`)

    // Superadmin inicial — solo si ese email todavía no tiene cuenta (el índice de email es global).
    const adminEmail = arg("admin-email")
    const adminPassword = arg("admin-password")
    if (adminEmail && adminPassword) {
      const existing = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, adminEmail))
      if (existing.length) {
        console.log(`superadmin "${adminEmail}" ya existe, omitido`)
      } else {
        await db.insert(adminUsers).values({
          tenantId: id,
          email: adminEmail,
          name: arg("admin-name") ?? "Superadmin",
          role: "superadmin",
          passwordHash: await hashPassword(adminPassword),
        })
        console.log(`superadmin "${adminEmail}" creado`)
      }
    } else {
      console.log("sin --admin-email / --admin-password — superadmin no creado")
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
