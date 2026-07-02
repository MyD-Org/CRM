import { describe, it, expect } from "vitest"
import { secureCompare, bearerMatches } from "@/lib/secure-compare"

describe("secureCompare", () => {
  it("true para strings iguales", () => {
    expect(secureCompare("abc123def456", "abc123def456")).toBe(true)
  })
  it("false para strings distintos del mismo largo", () => {
    expect(secureCompare("abc123def456", "abc123def457")).toBe(false)
  })
  it("false para largos distintos (sin tirar)", () => {
    expect(secureCompare("abc", "abcd")).toBe(false)
  })
  it("false para vacío vs no vacío", () => {
    expect(secureCompare("", "x")).toBe(false)
  })
})

describe("bearerMatches", () => {
  const secret = "internal-secret-value-123456"
  it("true con el secreto correcto", () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true)
  })
  it("false con secreto incorrecto", () => {
    expect(bearerMatches("Bearer wrong", secret)).toBe(false)
  })
  it("false sin prefijo Bearer", () => {
    expect(bearerMatches(secret, secret)).toBe(false)
  })
  it("false si el secreto esperado no está configurado", () => {
    expect(bearerMatches(`Bearer ${secret}`, undefined)).toBe(false)
    expect(bearerMatches(`Bearer ${secret}`, "")).toBe(false)
  })
  it("false con header null", () => {
    expect(bearerMatches(null, secret)).toBe(false)
  })
})
