import { describe, it, expect } from "vitest"
import { assignableRoles, canActOnRole, canManageUsers, roleRank } from "./roles"

describe("roles", () => {
  it("ranking operator < admin < superadmin", () => {
    expect(roleRank("operator")).toBeLessThan(roleRank("admin"))
    expect(roleRank("admin")).toBeLessThan(roleRank("superadmin"))
    expect(roleRank("desconocido")).toBe(0) // fallback seguro (mínimo privilegio)
  })

  it("canManageUsers: admin y superadmin sí, operator no", () => {
    expect(canManageUsers("operator")).toBe(false)
    expect(canManageUsers("admin")).toBe(true)
    expect(canManageUsers("superadmin")).toBe(true)
  })

  it("assignableRoles: el admin solo puede crear operadores", () => {
    expect(assignableRoles("superadmin")).toEqual(["operator", "admin", "superadmin"])
    expect(assignableRoles("admin")).toEqual(["operator"])
    expect(assignableRoles("operator")).toEqual([])
  })

  it("canActOnRole: admin solo sobre operadores; superadmin sobre todos", () => {
    // superadmin puede con cualquiera
    for (const target of ["operator", "admin", "superadmin"]) {
      expect(canActOnRole("superadmin", target)).toBe(true)
    }
    // admin solo con operadores
    expect(canActOnRole("admin", "operator")).toBe(true)
    expect(canActOnRole("admin", "admin")).toBe(false)
    expect(canActOnRole("admin", "superadmin")).toBe(false)
    // operator no puede con nadie
    expect(canActOnRole("operator", "operator")).toBe(false)
  })
})
