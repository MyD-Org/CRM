import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq, count, inArray } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { priceLists, catalogItems, tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { ConfiguracionShell } from "@/components/admin/ConfiguracionShell"
import { normalizeSchedule, normalizeExceptions } from "@/lib/schedule"
import { roleRank } from "@/lib/roles"

export const dynamic = "force-dynamic"

// Página accesible a admin y superadmin. Los tabs se filtran adentro:
// - Horarios → admin+superadmin.
// - Catálogo → superadmin-only (es data de plataforma, ver src/lib/roles.ts).
export default async function ConfiguracionPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (roleRank(session.role) < 1) notFound()
  const isSuperadmin = session.role === "superadmin"

  const db = getDb()

  // Excluimos fileData (bytea/Uint8Array): es el blob crudo del Excel, no se renderiza y
  // NO es serializable como prop de Server → Client Component (rompe el render). Además
  // evitamos cargar el archivo entero solo para listar.
  // El admin no ve el tab Catálogo → no cargamos priceLists si no es superadmin.
  const lists = isSuperadmin
    ? await db
        .select({
          id: priceLists.id,
          tenantId: priceLists.tenantId,
          name: priceLists.name,
          category: priceLists.category,
          priceColumns: priceLists.priceColumns,
          fileName: priceLists.fileName,
          active: priceLists.active,
          uploadedAt: priceLists.uploadedAt,
          createdAt: priceLists.createdAt,
        })
        .from(priceLists)
        .where(eq(priceLists.tenantId, session.tenantId))
        .orderBy(priceLists.createdAt)
    : []

  // Un COUNT agrupado en SQL, no una query por lista trayendo TODOS los ids para contarlos
  // en JS (con miles de ítems eso traía miles de filas solo para mostrar un número).
  const listIds = lists.map((l) => l.id)
  const [counts, [tenant]] = await Promise.all([
    listIds.length
      ? db
          .select({ priceListId: catalogItems.priceListId, count: count() })
          .from(catalogItems)
          .where(inArray(catalogItems.priceListId, listIds))
          .groupBy(catalogItems.priceListId)
      : Promise.resolve([]),
    db
      .select({
        paymentConditions: tenants.paymentConditions,
        schedule: tenants.schedule,
        scheduleExceptions: tenants.scheduleExceptions,
      })
      .from(tenants)
      .where(eq(tenants.id, session.tenantId)),
  ])
  const countMap = Object.fromEntries(counts.map((c) => [c.priceListId, c.count]))

  type PriceColumn = { key: string; label: string }
  const initialLists = lists.map((l) => ({
    ...l,
    priceColumns: (l.priceColumns as PriceColumn[]) ?? [],
    uploadedAt: l.uploadedAt.toISOString(),
    createdAt: l.createdAt.toISOString(),
    itemCount: countMap[l.id] ?? 0,
  }))
  const initialPaymentConditions = (tenant?.paymentConditions as { method: string; description: string }[]) ?? []
  const initialSchedule = {
    schedule: normalizeSchedule(tenant?.schedule),
    exceptions: normalizeExceptions(tenant?.scheduleExceptions),
  }

  return (
    <div className="p-4 md:p-6">
      {/* pl-10 md:pl-0: en mobile corre el título para que no lo tape el botón ☰ del sidebar. */}
      <div className="mb-6 pl-10 md:pl-0">
        <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Configuración</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>
          {isSuperadmin ? "Catálogo, horarios y datos del negocio para el agente" : "Horarios del negocio para el agente"}
        </p>
      </div>
      <ConfiguracionShell
        showCatalog={isSuperadmin}
        initialLists={initialLists}
        initialPaymentConditions={initialPaymentConditions}
        initialSchedule={initialSchedule}
      />
    </div>
  )
}
