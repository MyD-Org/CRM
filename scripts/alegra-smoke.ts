/**
 * Smoke test de la integración con Alegra contra una cuenta REAL (no hay sandbox).
 *
 *   npm run alegra:smoke -- --tenant new-avantec               # solo lecturas (inocuo)
 *   npm run alegra:smoke -- --tenant new-avantec --write-test  # + crea una cotización TEST y la BORRA
 *
 * Lee las credenciales de {PREFIX}_ALEGRA_EMAIL / {PREFIX}_ALEGRA_TOKEN (.env.local).
 * El write-test usa /estimates porque una cotización NO es documento fiscal y Alegra permite
 * borrarla por API: se crea marcada como TEST y se elimina en el mismo run. Si el borrado
 * fallara, el script lo avisa con el id para borrarla a mano desde Alegra.
 */
import type { TenantConfig } from "../src/lib/tenants"
import {
  searchContacts,
  listPriceLists,
  listPaymentTerms,
  listSellers,
  listTaxes,
  listCurrencies,
  createEstimate,
  getEstimate,
  deleteEstimate,
} from "../src/lib/alegra"

const args = process.argv.slice(2)
function argValue(flag: string): string | null {
  const idx = args.indexOf(flag)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null
}

const tenantId = argValue("--tenant") ?? "new-avantec"
const writeTest = args.includes("--write-test")
const contactQuery = argValue("--contact-query") // opcional: buscar un contacto puntual

const prefix = tenantId.toUpperCase().replace(/-/g, "_")
const email = process.env[`${prefix}_ALEGRA_EMAIL`] ?? ""
const token = process.env[`${prefix}_ALEGRA_TOKEN`] ?? ""

if (!email || !token) {
  console.error(`Faltan ${prefix}_ALEGRA_EMAIL / ${prefix}_ALEGRA_TOKEN en .env.local`)
  process.exit(1)
}

// Config mínima: el cliente de Alegra solo usa alegraEmail/alegraToken/alegraMock.
const config = {
  id: tenantId,
  alegraEmail: email,
  alegraToken: token,
  alegraMock: false,
} as TenantConfig

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`)
}

async function main() {
  console.log(`Smoke test Alegra — tenant=${tenantId} (cuenta REAL, lecturas${writeTest ? " + write-test" : ""})`)

  section("Listas de precio (/price-lists)")
  const priceLists = await listPriceLists(config)
  for (const p of priceLists) console.log(`  [${p.alegraId}] ${p.name} (${p.status})`)

  section("Condiciones de pago (/terms)")
  const terms = await listPaymentTerms(config)
  for (const t of terms) console.log(`  [${t.alegraId}] ${t.name}${t.days != null ? ` — ${t.days} días` : ""}`)

  section("Vendedores (/sellers)")
  const sellers = await listSellers(config)
  for (const s of sellers) console.log(`  [${s.alegraId}] ${s.name} (${s.status})`)

  section("Impuestos (/taxes)")
  const taxes = await listTaxes(config)
  for (const t of taxes) console.log(`  [${t.alegraId}] ${t.name}${t.percentage != null ? ` ${t.percentage}%` : ""}`)

  section("Monedas (/currencies)")
  const currencies = await listCurrencies(config)
  for (const c of currencies) console.log(`  ${c.code} — ${c.name}${c.exchangeRate ? ` (TC ${c.exchangeRate})` : ""}`)

  section("Muestra de productos (/items, primeros 5)")
  const itemsRes = await fetch("https://api.alegra.com/api/v1/items?limit=5", {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      Accept: "application/json",
    },
  })
  if (!itemsRes.ok) throw new Error(`items ${itemsRes.status}`)
  const items = (await itemsRes.json()) as { id: unknown; name?: string; reference?: unknown }[]
  for (const it of items) console.log(`  [${it.id}] ${it.name ?? "(sin nombre)"}`)

  section(`Contactos (${contactQuery ? `búsqueda "${contactQuery}"` : "muestra"})`)
  const contactsRes = await fetch(
    `https://api.alegra.com/api/v1/contacts?limit=5${contactQuery ? `&query=${encodeURIComponent(contactQuery)}` : ""}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
    },
  )
  if (!contactsRes.ok) throw new Error(`contacts ${contactsRes.status}`)
  const contacts = (await contactsRes.json()) as { id: unknown; name?: string }[]
  for (const c of contacts) console.log(`  [${c.id}] ${c.name ?? "(sin nombre)"}`)

  if (contactQuery) {
    const viaLib = await searchContacts(config, contactQuery, 5)
    console.log(`  (searchContacts de la lib devolvió ${viaLib.length} resultados)`)
  }

  if (!writeTest) {
    console.log("\nOK — solo lecturas, no se creó nada en la cuenta.")
    return
  }

  // ── Write-test: crear cotización TEST → verificar → BORRAR ──
  section("Write-test: cotización TEST (se borra al final)")
  const contactId = contacts[0]?.id != null ? String(contacts[0].id) : null
  const itemId = items[0]?.id != null ? String(items[0].id) : null
  if (!contactId || !itemId) {
    console.error("  No hay contacto/producto para el write-test — abortado (no se creó nada).")
    process.exit(1)
  }

  const marker = `PRUEBA DE INTEGRACIÓN CRM — creada automáticamente por alegra-smoke ${new Date().toISOString()} — BORRAR si quedó`
  const created = await createEstimate(config, {
    contactAlegraId: contactId,
    items: [{ alegraId: itemId, quantity: 1 }],
    observations: marker,
    anotation: marker,
  })
  console.log(`  Creada: id=${created.alegraId} nº=${created.number} total=${created.total} cliente="${created.clientName}"`)

  const fetched = await getEstimate(config, created.alegraId)
  console.log(`  Releída OK: ${fetched ? `total=${fetched.total}` : "NO ENCONTRADA (raro)"}`)

  try {
    await deleteEstimate(config, created.alegraId)
    const gone = await getEstimate(config, created.alegraId)
    if (gone) {
      console.error(`  ⚠ La cotización ${created.alegraId} sigue existiendo — borrala a mano desde Alegra.`)
      process.exit(1)
    }
    console.log(`  Borrada OK — la cuenta quedó como estaba.`)
  } catch (err) {
    console.error(`  ⚠ Falló el borrado de la cotización ${created.alegraId} — BORRALA A MANO desde Alegra (Ventas → Cotizaciones).`)
    throw err
  }

  console.log("\nOK — write-test completo, sin datos residuales.")
}

main().catch((err) => {
  console.error("\nSmoke test FALLÓ:", err instanceof Error ? err.message : err)
  process.exit(1)
})
