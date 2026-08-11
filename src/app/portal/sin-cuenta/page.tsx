import { UserButton } from "@clerk/nextjs"
import { identidadPortal } from "@/lib/portal-auth"
import { getTenantConfig } from "@/lib/tenant-context"

export const dynamic = "force-dynamic"

/**
 * Entró con Clerk pero su email no figura en ningún contacto del ERP.
 *
 * No hay autoservicio para resolverlo, y es a propósito: dejar que alguien
 * escriba un CUIT y quede vinculado sería regalar la cuenta de esa empresa
 * —los CUIT son públicos en Argentina—. Quien puede arreglarlo es atención,
 * cargando el email correcto en el contacto; después el match es automático.
 */
export default async function SinCuentaPage() {
  const { email } = await identidadPortal()

  let whatsapp: string | undefined
  let tenantName = "nosotros"
  try {
    const t = await getTenantConfig()
    whatsapp = t.whatsappNumber ?? undefined
    tenantName = t.name
  } catch {}

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-5 px-4 py-16 text-center">
      <h1 className="text-2xl font-extrabold">Todavía no te reconocemos</h1>
      <p className="text-sm text-gray-500">
        Entraste como <span className="font-semibold text-gray-800">{email ?? "tu cuenta"}</span>,
        pero ese correo no figura en tu ficha de cliente de {tenantName}.
      </p>
      <p className="text-sm text-gray-500">
        Escribinos con tu CUIT y lo asociamos: la próxima vez que ingreses, tus
        facturas y tu cuenta aparecen solas.
      </p>

      {whatsapp && (
        <a
          href={`https://wa.me/${whatsapp.replace(/\D/g, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-[#0a1f44] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
        >
          Escribir por WhatsApp
        </a>
      )}

      <div className="pt-2">
        <UserButton />
      </div>
    </main>
  )
}
