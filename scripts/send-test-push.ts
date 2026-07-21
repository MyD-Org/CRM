/**
 * Envía una notificación push de PRUEBA a las suscripciones guardadas en la DB.
 *
 *   npm run push:test                          # a TODAS las suscripciones
 *   npm run push:test -- --email vos@mail.com  # solo a las de ese operador
 *
 * Requiere en el entorno: DATABASE_URL + VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (+ VAPID_SUBJECT).
 * Para apuntar a PROD: `vercel env pull .env.local --environment=production` y luego correrlo.
 * Poda automáticamente las suscripciones muertas (404/410).
 */
import webpush from "web-push"
import { eq } from "drizzle-orm"
import { getDb } from "../src/db"
import { pushSubscriptions, adminUsers } from "../src/db/schema"

function parseEmail(): string | null {
  const i = process.argv.indexOf("--email")
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

async function main() {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) {
    console.error("✗ Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en el entorno.")
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) {
    console.error("✗ Falta DATABASE_URL. Para prod: vercel env pull .env.local --environment=production")
    process.exit(1)
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:soporte@myd-org.com", publicKey, privateKey)

  const db = getDb()
  const email = parseEmail()

  const rows = email
    ? await db
        .select({
          id: pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
          who: adminUsers.email,
        })
        .from(pushSubscriptions)
        .innerJoin(adminUsers, eq(pushSubscriptions.operatorId, adminUsers.id))
        .where(eq(adminUsers.email, email))
    : await db
        .select({
          id: pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
          who: adminUsers.email,
        })
        .from(pushSubscriptions)
        .innerJoin(adminUsers, eq(pushSubscriptions.operatorId, adminUsers.id))

  if (!rows.length) {
    console.log(
      email
        ? `⚠ No hay suscripciones guardadas para ${email}. Entrá al backoffice desde el celu y tocá "Activar" primero.`
        : "⚠ No hay ninguna suscripción guardada. Entrá al backoffice desde el celu y tocá \"Activar\" primero.",
    )
    process.exit(0)
  }

  const payload = JSON.stringify({
    title: "Notificación de prueba",
    body: "Si ves esto, el push del CRM funciona.",
    url: "/admin/inbox",
    tag: "test-push",
  })

  console.log(`Enviando a ${rows.length} suscripción(es)...`)
  let ok = 0
  let pruned = 0
  for (const s of rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      ok++
      console.log(`  ✓ ${s.who} — ${s.endpoint.slice(0, 45)}…`)
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode
      if (statusCode === 404 || statusCode === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id))
        pruned++
        console.log(`  ⌫ ${s.who} — suscripción muerta (${statusCode}), borrada`)
      } else {
        console.error(`  ✗ ${s.who} — error ${statusCode ?? ""}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
  console.log(`\nListo. Enviadas: ${ok}, podadas: ${pruned}.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
