import { SignIn } from "@clerk/nextjs"
import { getTenantConfig } from "@/lib/tenant-context"

/**
 * Login del portal de clientes.
 *
 * Catch-all opcional (`[[...rest]]`) porque Clerk usa sub-rutas propias para
 * los pasos del flujo (verificación, callback de SSO, factor-two). Con una
 * `page.tsx` plana, cualquiera de esos pasos daría 404 a mitad del login.
 */
export default async function IngresarPortalPage() {
  let tenantName = "tu cuenta"
  try {
    tenantName = (await getTenantConfig()).name
  } catch {}

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-extrabold">Portal de clientes</h1>
        <p className="mt-2 text-sm text-gray-500">
          Ingresá para ver tus facturas y el estado de tu cuenta en {tenantName}.
        </p>
      </div>
      <SignIn />
    </main>
  )
}
