import { createHmac } from "crypto"
import { describe, it, expect } from "vitest"
import { mintAgentToken, verifyAgentToken } from "@/lib/agent-token"

// SESSION_SECRET lo inyecta vitest.config.ts (test.env). Debe coincidir con el que
// usa agent-token para firmar, así que lo leemos de process.env en los helpers de test.
const SECRET = process.env.SESSION_SECRET as string

function sign(payload: string) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url")
}

describe("mint/verify agent token (con tenant)", () => {
  it("roundtrip conserva codigocliente y tenantId", () => {
    const token = mintAgentToken("CLI-1", "central-led")
    expect(verifyAgentToken(token)).toEqual({ codigocliente: "CLI-1", tenantId: "central-led" })
  })

  it("rechaza firma alterada", () => {
    const [payload] = mintAgentToken("CLI-1", "central-led").split(".")
    expect(verifyAgentToken(`${payload}.deadbeef`)).toBeNull()
  })

  it("rechaza token con payload manipulado (otro tenant, firma vieja)", () => {
    // Reusar la firma de un tenant sobre un payload de otro no valida.
    const t1 = mintAgentToken("CLI-1", "tenant-a")
    const [, sig] = t1.split(".")
    const forged = Buffer.from(JSON.stringify({ c: "CLI-1", t: "tenant-b", e: Date.now() + 1000 })).toString("base64url")
    expect(verifyAgentToken(`${forged}.${sig}`)).toBeNull()
  })

  it("rechaza tokens del formato viejo sin tenant { c, e }", () => {
    const payload = Buffer.from(JSON.stringify({ c: "CLI-1", e: Date.now() + 1000 })).toString("base64url")
    expect(verifyAgentToken(`${payload}.${sign(payload)}`)).toBeNull()
  })

  it("rechaza tokens expirados", () => {
    const payload = Buffer.from(JSON.stringify({ c: "CLI-1", t: "central-led", e: Date.now() - 1 })).toString("base64url")
    expect(verifyAgentToken(`${payload}.${sign(payload)}`)).toBeNull()
  })

  it("rechaza tokens malformados", () => {
    expect(verifyAgentToken("garbage")).toBeNull()
    expect(verifyAgentToken("")).toBeNull()
  })
})
