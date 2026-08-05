import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { notFound } from "next/navigation"
import { adminSessionOptions, type AdminSessionData } from "@/lib/admin-session"
import { TemplateManager } from "@/components/admin/TemplateManager"

export const dynamic = "force-dynamic"

// Gestión de plantillas de WhatsApp. Solo superadmin: crea recursos reales en Meta.
export default async function PlantillasPage() {
  const session = await getIronSession<AdminSessionData>(await cookies(), adminSessionOptions)
  if (session.role !== "superadmin") notFound()

  return (
    <div className="p-4 md:p-6">
      <TemplateManager />
    </div>
  )
}
