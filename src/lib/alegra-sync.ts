import { and, eq, lt, sql } from "drizzle-orm"
import { getDb } from "@/db"
import { catalogCategories, catalogProducts, catalogSyncLog } from "@/db/schema"
import type { TenantConfig } from "./tenants"
import { listAllCategories, listAllItems } from "./alegra"

// Sincroniza el catálogo de Alegra a la cache local (upsert por alegraId). Lo que no se ve en la
// corrida se marca 'inactive' (stale), solo si el run completó OK. Deja bitácora en catalog_sync_log.
// Ver ADR catálogo Alegra (cache + live).

const CHUNK = 500

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export interface SyncResult {
  ok: boolean
  itemsSynced: number
  categoriesSynced: number
  error?: string
}

export async function syncCatalog(config: TenantConfig, trigger: "cron" | "manual"): Promise<SyncResult> {
  const db = getDb()
  const runStart = new Date()
  const [log] = await db
    .insert(catalogSyncLog)
    .values({ tenantId: config.id, trigger, status: "running", startedAt: runStart })
    .returning({ id: catalogSyncLog.id })

  try {
    // ── Categorías ──
    const categories = await listAllCategories(config)
    for (const batch of chunk(categories, CHUNK)) {
      await db
        .insert(catalogCategories)
        .values(
          batch.map((c) => ({
            tenantId: config.id,
            alegraId: c.alegraId,
            name: c.name,
            parentAlegraId: c.parentAlegraId,
            status: "active",
            syncedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [catalogCategories.tenantId, catalogCategories.alegraId],
          set: {
            name: sql`excluded.name`,
            parentAlegraId: sql`excluded.parent_alegra_id`,
            status: sql`excluded.status`,
            syncedAt: sql`excluded.synced_at`,
          },
        })
    }

    // ── Productos ──
    const items = await listAllItems(config)
    for (const batch of chunk(items, CHUNK)) {
      await db
        .insert(catalogProducts)
        .values(
          batch.map((it) => ({
            tenantId: config.id,
            alegraId: it.alegraId,
            code: it.code,
            name: it.name,
            description: it.description,
            categoryAlegraId: it.categoryAlegraId,
            prices: it.prices,
            stock: it.stock != null ? String(it.stock) : null,
            status: "active",
            images: it.images,
            syncedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [catalogProducts.tenantId, catalogProducts.alegraId],
          set: {
            code: sql`excluded.code`,
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            categoryAlegraId: sql`excluded.category_alegra_id`,
            prices: sql`excluded.prices`,
            stock: sql`excluded.stock`,
            status: sql`excluded.status`,
            images: sql`excluded.images`,
            syncedAt: sql`excluded.synced_at`,
          },
        })
    }

    // ── Stale: lo no visto en esta corrida queda inactive (no se borra, soft) ──
    await db
      .update(catalogProducts)
      .set({ status: "inactive" })
      .where(and(eq(catalogProducts.tenantId, config.id), lt(catalogProducts.syncedAt, runStart)))
    await db
      .update(catalogCategories)
      .set({ status: "inactive" })
      .where(and(eq(catalogCategories.tenantId, config.id), lt(catalogCategories.syncedAt, runStart)))

    await db
      .update(catalogSyncLog)
      .set({
        status: "ok",
        itemsSynced: items.length,
        categoriesSynced: categories.length,
        finishedAt: new Date(),
      })
      .where(eq(catalogSyncLog.id, log.id))

    return { ok: true, itemsSynced: items.length, categoriesSynced: categories.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync_failed"
    await db
      .update(catalogSyncLog)
      .set({ status: "error", error: message, finishedAt: new Date() })
      .where(eq(catalogSyncLog.id, log.id))
    return { ok: false, itemsSynced: 0, categoriesSynced: 0, error: message }
  }
}
