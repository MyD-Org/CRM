import { cookies } from "next/headers"
import { getIronSession } from "iron-session"
import { redirect } from "next/navigation"
import { sessionOptions } from "@/lib/session"
import { mockCliente, mockFacturas, mockPagos, mockPresupuestos } from "@/lib/mock-data"
import { DashboardClient } from "@/components/portal/DashboardClient"
import type { SessionData } from "@/types"

export default async function DashboardPage() {
  const cookieStore = await cookies()
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  if (!session.isLoggedIn) {
    redirect("/portal")
  }

  return (
    <DashboardClient
      cliente={mockCliente}
      facturas={mockFacturas}
      pagos={mockPagos}
      presupuestos={mockPresupuestos}
      razonsocial={session.razonsocial ?? mockCliente.razonsocial}
    />
  )
}
