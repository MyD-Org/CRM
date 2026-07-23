import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { getDb } from "@/db"
import { tenants } from "@/db/schema"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { getUsageSummary, type UsageSummary } from "@/lib/inbox-api"
import { botUsagePanelEnabled } from "@/lib/flags"
import { UsagePanel } from "@/components/admin/UsagePanel"

export const dynamic = "force-dynamic"

export default async function UsoPage() {
  // Feature gateada por flag (migrará a ia-dashboard). Off → la página no existe.
  if (!(await botUsagePanelEnabled())) notFound()

  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  // El gasto es información de administración: solo superadmin (igual que el guard del endpoint).
  if (session.role !== "superadmin") notFound()

  const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, session.tenantId))

  let summary: UsageSummary | null = null
  let configError = ""

  if (!tenant?.aiTenantId || !tenant?.aiApiUrl) {
    configError = "El inbox no está configurado. Completá AI_TENANT_ID y AI_API_URL en la config del tenant."
  } else {
    try {
      summary = await getUsageSummary(tenant.aiApiUrl, tenant.aiTenantId, 30)
    } catch {
      configError = "No se pudo conectar con la API. Verificá la configuración."
    }
  }

  return (
    <div className="p-4 md:p-6">
      {/* pl-10 md:pl-0: en mobile corre el título para que no lo tape el botón ☰ del sidebar. */}
      <div className="mb-6 pl-10 md:pl-0">
        <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>Uso del bot</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--ink-soft)" }}>
          Consumo de tokens y costo estimado del asistente de IA
        </p>
      </div>

      {configError ? (
        <div className="rounded-[var(--radius)] p-4 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          {configError}
        </div>
      ) : (
        <UsagePanel initial={summary!} />
      )}
    </div>
  )
}
