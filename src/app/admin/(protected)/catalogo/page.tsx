import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq, and } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { priceLists, catalogItems, tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { CatalogManager } from "@/components/admin/CatalogManager"

export const dynamic = "force-dynamic"

export default async function CatalogoPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (session.role !== "superadmin") notFound()

  const db = getDb()

  const lists = await db
    .select()
    .from(priceLists)
    .where(eq(priceLists.tenantId, session.tenantId))
    .orderBy(priceLists.createdAt)

  const counts = await Promise.all(
    lists.map(async (l) => {
      const items = await db.select({ id: catalogItems.id }).from(catalogItems).where(eq(catalogItems.priceListId, l.id))
      return { id: l.id, count: items.length }
    }),
  )
  const countMap = Object.fromEntries(counts.map((c) => [c.id, c.count]))

  const [tenant] = await db
    .select({ paymentConditions: tenants.paymentConditions })
    .from(tenants)
    .where(eq(tenants.id, session.tenantId))

  type PriceColumn = { key: string; label: string }
  const initialLists = lists.map((l) => ({
    ...l,
    priceColumns: (l.priceColumns as PriceColumn[]) ?? [],
    uploadedAt: l.uploadedAt.toISOString(),
    createdAt: l.createdAt.toISOString(),
    itemCount: countMap[l.id] ?? 0,
  }))
  const initialPaymentConditions = (tenant?.paymentConditions as { method: string; description: string }[]) ?? []

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Catálogo</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>
          Listas de precios y condiciones de pago para el agente de ventas
        </p>
      </div>
      <CatalogManager initialLists={initialLists} initialPaymentConditions={initialPaymentConditions} />
    </div>
  )
}
