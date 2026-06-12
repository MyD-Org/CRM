import { getTenantConfig } from "@/lib/tenant-context"
import LoginPage from "@/components/portal/LoginPage"

export default async function PortalPage() {
  const tenant = await getTenantConfig()

  return (
    <LoginPage
      logoSrc={tenant.logoPath}
      tenantName={tenant.name}
      tenantSubtitle={tenant.subtitle}
    />
  )
}
