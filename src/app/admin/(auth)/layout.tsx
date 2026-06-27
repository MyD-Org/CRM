import { getTenantConfig } from "@/lib/tenant-context"
import { Logo } from "@/components/portal/Logo"

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const tenant = await getTenantConfig()

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: "#eef1f5",
        backgroundImage:
          "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(31,140,255,0.18) 0%, transparent 70%)",
      }}
    >
      <header className="w-full flex items-center px-8 py-4" style={{ background: "transparent" }}>
        <Logo size="md" showSubtitle src={tenant.logoPath} name={tenant.name} subtitle={tenant.subtitle} />
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        {children}
      </main>
    </div>
  )
}
