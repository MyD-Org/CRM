// Origen absoluto del request (https://{host}) para armar links en mails. El host ya fue
// validado por el proxy (un host desconocido nunca llega acá: responde 404 antes), así que
// acá solo se compone el string — nunca un host hardcodeado ni una URL firmada.
// El proto viene de `x-forwarded-proto` (lo pone el proxy) y defaulta a https: el proxy
// termina TLS, así que un request HTTP plano solo existe en dev local.

export function requestOrigin(req: Request): string {
  const protoHeader = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() ?? ""
  const proto = protoHeader === "http" || protoHeader === "https" ? protoHeader : "https"
  const host = (req.headers.get("host") ?? req.headers.get("x-forwarded-host") ?? "").split(",")[0]?.trim() ?? ""
  return `${proto}://${host}`
}
