import { runNotifications } from "@/lib/notifications"

// Disparo automático — lo invoca Vercel Cron (o curl en dev) con el secret.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization")
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  try {
    const result = await runNotifications()
    return Response.json(result)
  } catch (err) {
    console.error("cron/notifications error:", err)
    return Response.json({ error: "internal_error" }, { status: 500 })
  }
}

// Vercel Cron usa GET
export const GET = POST
