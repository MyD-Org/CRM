import { describe, it, expect } from "vitest"
import {
  normalizeDepartment,
  pickLeastLoaded,
  loadFromAssignments,
  type Operator,
  type Assignment,
} from "./assignment"

describe("normalizeDepartment", () => {
  it("baja a minúscula, quita acentos y usa guiones", () => {
    expect(normalizeDepartment("Cuentas Corrientes")).toBe("cuentas-corrientes")
    expect(normalizeDepartment("Ventas")).toBe("ventas")
    expect(normalizeDepartment("Asesoramiento Técnico")).toBe("asesoramiento-tecnico")
  })

  it("hace equivalentes la etiqueta del bot y el slug del CRM", () => {
    expect(normalizeDepartment("Cuentas Corrientes")).toBe(normalizeDepartment("cuentas-corrientes"))
  })

  it("tolera null/undefined/vacío", () => {
    expect(normalizeDepartment(null)).toBe("")
    expect(normalizeDepartment(undefined)).toBe("")
    expect(normalizeDepartment("   ")).toBe("")
  })
})

describe("loadFromAssignments", () => {
  const assignments: Assignment[] = [
    { conversationId: "c1", operatorId: "op1", department: null },
    { conversationId: "c2", operatorId: "op1", department: null },
    { conversationId: "c3", operatorId: "op2", department: null },
    { conversationId: "c4", operatorId: "op2", department: null }, // inactiva
  ]

  it("cuenta solo las conversaciones activas por operador", () => {
    const active = new Set(["c1", "c2", "c3"]) // c4 quedó fuera (cerrada)
    const load = loadFromAssignments(assignments, active)
    expect(load.get("op1")).toBe(2)
    expect(load.get("op2")).toBe(1)
  })

  it("ignora asignaciones de conversaciones no activas", () => {
    const load = loadFromAssignments(assignments, new Set())
    expect(load.size).toBe(0)
  })
})

describe("pickLeastLoaded", () => {
  const ops: Operator[] = [
    { id: "op1", departments: ["ventas"] },
    { id: "op2", departments: ["ventas"] },
  ]

  it("elige el operador con menos carga", () => {
    const load = new Map([["op1", 3], ["op2", 1]])
    expect(pickLeastLoaded(ops, load)?.id).toBe("op2")
  })

  it("trata a un operador sin entrada en el mapa como carga 0", () => {
    const load = new Map([["op1", 5]]) // op2 no está → 0
    expect(pickLeastLoaded(ops, load)?.id).toBe("op2")
  })

  it("devuelve null si no hay candidatos", () => {
    expect(pickLeastLoaded([], new Map())).toBeNull()
  })
})
