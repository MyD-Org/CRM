"use client"

import { useState } from "react"
import { Tabs } from "@myd-org/ui"
import { CatalogManager } from "./CatalogManager"
import { ScheduleForm, type Schedule } from "./ScheduleForm"

type PriceColumn = { key: string; label: string }

type PriceList = {
  id: string
  tenantId: string
  name: string
  category: string
  priceColumns: PriceColumn[]
  fileName: string | null
  active: boolean
  uploadedAt: string
  createdAt: string
  itemCount: number
}

type PaymentCondition = { method: string; description: string }

interface Props {
  // `false` para admins: se oculta el tab Catálogo (superadmin-only) y arranca en Horarios.
  showCatalog: boolean
  initialLists: PriceList[]
  initialPaymentConditions: PaymentCondition[]
  initialSchedule: Schedule
}

type Tab = "catalogo" | "horarios"

export function ConfiguracionShell({ showCatalog, initialLists, initialPaymentConditions, initialSchedule }: Props) {
  const [tab, setTab] = useState<Tab>(showCatalog ? "catalogo" : "horarios")

  const items = showCatalog
    ? [
        { value: "catalogo", label: "Catálogo" },
        { value: "horarios", label: "Horarios" },
      ]
    : [{ value: "horarios", label: "Horarios" }]

  return (
    <div className="flex flex-col gap-4">
      <Tabs variant="underline" value={tab} onValueChange={(v) => setTab(v as Tab)} items={items} />

      {tab === "catalogo" && showCatalog && (
        <CatalogManager initialLists={initialLists} initialPaymentConditions={initialPaymentConditions} />
      )}
      {tab === "horarios" && <ScheduleForm initialSchedule={initialSchedule} />}
    </div>
  )
}
