"use client"

import { ChatDrawer } from "@myd-org/ai-widget/preset"
import "@myd-org/ai-widget/styles"

async function fetchToken(): Promise<string> {
  const r = await fetch("/api/ai/token", { method: "POST" })
  if (!r.ok) throw new Error(`token ${r.status}`)
  const { token } = (await r.json()) as { token: string }
  return token
}

export function AssistantWidget() {
  const agentId = process.env.NEXT_PUBLIC_AI_AGENT_ID
  if (!agentId) return null
  return (
    <ChatDrawer
      config={{ baseUrl: "/ai-api", agentId, fetchToken }}
      branding={{ title: "Central LED", primaryColor: "#c4161c" }}
    />
  )
}
