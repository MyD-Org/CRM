import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/db"
import { adminUsers } from "@/db/schema"
import { seedTenant, seedOperator, truncateAll } from "./helpers"

// Tests de AUTORIZACIÓN a nivel de RUTA. lib/roles.ts ya tiene tests unitarios de la lógica
// (quién puede asignar qué rol), pero eso no garantiza que las rutas la USEN: si alguien
// borrara el chequeo de una ruta, esos tests seguirían en verde. Acá invocamos los handlers
// reales contra la DB de test y verificamos los status que devuelven.
//
// Se mockea solo la sesión (quién está logueado) y el envío de mail; la DB y toda la lógica
// de permisos son las de verdad.

let session: Record<string, unknown>

vi.mock("next/headers", () => ({ cookies: async () => ({}) }))
vi.mock("iron-session", () => ({ getIronSession: async () => session }))
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ error: null }) }
  },
}))

const { POST: inviteUser } = await import("@/app/api/admin/usuarios/route")
const { PATCH: patchUser, DELETE: deleteUser } = await import("@/app/api/admin/usuarios/[id]/route")

const TENANT = "test-tenant"

function loginAs(userId: string, role: "operator" | "admin" | "superadmin") {
  session = { userId, role, tenantId: TENANT, name: "Test", email: "t@x.com", save: async () => {} }
}

function invite(body: unknown) {
  return inviteUser(
    new NextRequest("http://localhost/api/admin/usuarios", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  )
}

function patch(targetId: string, body: unknown) {
  return patchUser(
    new NextRequest(`http://localhost/api/admin/usuarios/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: targetId }) },
  )
}

function remove(targetId: string) {
  return deleteUser(
    new NextRequest(`http://localhost/api/admin/usuarios/${targetId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: targetId }) },
  )
}

describe("permisos en las rutas de usuarios", () => {
  let operador: string
  let admin: string
  let otroAdmin: string
  let superadmin: string

  beforeEach(async () => {
    await truncateAll()
    await seedTenant(TENANT)
    operador = await seedOperator(TENANT, { role: "operator", name: "Opes" })
    admin = await seedOperator(TENANT, { role: "admin", name: "Admin" })
    otroAdmin = await seedOperator(TENANT, { role: "admin", name: "Otro Admin" })
    superadmin = await seedOperator(TENANT, { role: "superadmin", name: "Dueña" })
  })

  describe("invitar (POST)", () => {
    it("el operador no puede invitar a nadie", async () => {
      loginAs(operador, "operator")
      const res = await invite({ name: "X", email: "x@x.com", role: "operator" })
      expect(res.status).toBe(403)
    })

    it("el admin puede invitar operadores", async () => {
      loginAs(admin, "admin")
      const res = await invite({ name: "Nuevo", email: "nuevo@x.com", role: "operator" })
      expect(res.status).toBe(201)
    })

    it("el admin puede invitar otros admins", async () => {
      loginAs(admin, "admin")
      const res = await invite({ name: "Nuevo Admin", email: "na@x.com", role: "admin" })
      expect(res.status).toBe(201)
    })

    it("el admin NO puede crear un superadmin (frontera dura)", async () => {
      loginAs(admin, "admin")
      const res = await invite({ name: "Colado", email: "colado@x.com", role: "superadmin" })
      expect(res.status).toBe(403)
      // y no quedó creado
      const rows = await getDb().select().from(adminUsers).where(eq(adminUsers.email, "colado@x.com"))
      expect(rows).toHaveLength(0)
    })

    it("el superadmin sí puede crear superadmins", async () => {
      loginAs(superadmin, "superadmin")
      const res = await invite({ name: "Socia", email: "socia@x.com", role: "superadmin" })
      expect(res.status).toBe(201)
    })
  })

  describe("editar (PATCH)", () => {
    it("el admin puede editar a un operador", async () => {
      loginAs(admin, "admin")
      expect((await patch(operador, { name: "Renombrado" })).status).toBe(200)
    })

    it("el admin puede editar a otro admin", async () => {
      loginAs(admin, "admin")
      expect((await patch(otroAdmin, { name: "Renombrado" })).status).toBe(200)
    })

    it("el admin NO puede editar a un superadmin", async () => {
      loginAs(admin, "admin")
      const res = await patch(superadmin, { name: "Hackeado" })
      expect(res.status).toBe(403)
      const [row] = await getDb().select().from(adminUsers).where(eq(adminUsers.id, superadmin))
      expect(row.name).toBe("Dueña") // no se modificó
    })

    it("el admin NO puede promover a nadie a superadmin", async () => {
      loginAs(admin, "admin")
      const res = await patch(operador, { role: "superadmin" })
      expect(res.status).toBe(403)
      const [row] = await getDb().select().from(adminUsers).where(eq(adminUsers.id, operador))
      expect(row.role).toBe("operator") // siguió siendo operador
    })

    it("el operador no puede editar a otro usuario", async () => {
      loginAs(operador, "operator")
      expect((await patch(admin, { name: "X" })).status).toBe(403)
    })

    it("cualquiera puede editar su propio nombre", async () => {
      loginAs(operador, "operator")
      expect((await patch(operador, { name: "Mi Nombre" })).status).toBe(200)
    })
  })

  describe("eliminar (DELETE)", () => {
    it("el admin puede eliminar a un operador", async () => {
      loginAs(admin, "admin")
      expect((await remove(operador)).status).toBe(200)
    })

    it("el admin NO puede eliminar a un superadmin", async () => {
      loginAs(admin, "admin")
      expect((await remove(superadmin)).status).toBe(403)
      const rows = await getDb().select().from(adminUsers).where(eq(adminUsers.id, superadmin))
      expect(rows).toHaveLength(1) // sigue existiendo
    })

    it("el operador no puede eliminar a nadie", async () => {
      loginAs(operador, "operator")
      expect((await remove(admin)).status).toBe(403)
    })

    it("nadie puede eliminarse a sí mismo", async () => {
      loginAs(superadmin, "superadmin")
      expect((await remove(superadmin)).status).toBe(400)
    })
  })
})
