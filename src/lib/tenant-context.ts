import { headers } from "next/headers"
import { getTenantByIdFromDb, type TenantConfig } from "./tenants"

export async function getTenantConfig(): Promise<TenantConfig> {
  const headersList = await headers()
  const tenantId = headersList.get("x-tenant-id")

  if (!tenantId) throw new Error("No x-tenant-id header — middleware may not be running")

  const config = await getTenantByIdFromDb(tenantId)
  if (!config) throw new Error(`Tenant not found: ${tenantId}`)

  return config
}
