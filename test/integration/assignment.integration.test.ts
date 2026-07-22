import { describe, it, expect, beforeEach } from "vitest"
import { assignInCrm, getAssignments, availableOperators } from "@/lib/assignment"
import { seedTenant, seedOperator, truncateAll } from "./helpers"

// Tests de integración de la asignación conversación→operador contra la DB real (crm_test).
// Verifican el upsert, el índice único (un operador por conversación) y el filtro de
// operadores disponibles por departamento — cosas que un unit test con mocks no cubriría.

describe("assignInCrm / getAssignments (DB)", () => {
  let tenant: string
  let op1: string
  let op2: string

  beforeEach(async () => {
    await truncateAll()
    tenant = await seedTenant()
    op1 = await seedOperator(tenant, { name: "Op Uno" })
    op2 = await seedOperator(tenant, { name: "Op Dos" })
  })

  it("persiste una asignación y la lee de vuelta", async () => {
    await assignInCrm(tenant, "conv-1", op1, "ventas")
    const rows = await getAssignments(tenant)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conversationId: "conv-1", operatorId: op1, department: "ventas" })
  })

  it("hace upsert: reasignar la misma conversación cambia el operador, no duplica", async () => {
    await assignInCrm(tenant, "conv-1", op1, "ventas")
    await assignInCrm(tenant, "conv-1", op2, "soporte")
    const rows = await getAssignments(tenant)
    expect(rows).toHaveLength(1) // el índice único (tenant, conversation) evita el duplicado
    expect(rows[0].operatorId).toBe(op2)
    expect(rows[0].department).toBe("soporte")
  })

  it("mantiene asignaciones independientes por conversación", async () => {
    await assignInCrm(tenant, "conv-1", op1, null)
    await assignInCrm(tenant, "conv-2", op2, null)
    const rows = await getAssignments(tenant)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.operatorId))).toEqual(new Set([op1, op2]))
  })
})

describe("availableOperators (DB)", () => {
  let tenant: string

  beforeEach(async () => {
    await truncateAll()
    tenant = await seedTenant()
    await seedOperator(tenant, { name: "Ventas disp", departments: ["ventas"], availability: "available" })
    await seedOperator(tenant, { name: "Ventas ausente", departments: ["ventas"], availability: "away" })
    await seedOperator(tenant, { name: "Soporte disp", departments: ["soporte"], availability: "available" })
  })

  it("devuelve solo los operadores disponibles del departamento pedido", async () => {
    const ops = await availableOperators(tenant, "ventas")
    expect(ops).toHaveLength(1)
    expect(ops[0].departments).toContain("ventas")
  })

  it("matchea el departamento sin importar el formato (etiqueta del bot vs slug)", async () => {
    const ops = await availableOperators(tenant, "Ventas")
    expect(ops).toHaveLength(1)
  })

  it("sin departamento devuelve todos los disponibles del tenant", async () => {
    const ops = await availableOperators(tenant, null)
    expect(ops).toHaveLength(2) // ventas-disp + soporte-disp (el ausente queda afuera)
  })
})
