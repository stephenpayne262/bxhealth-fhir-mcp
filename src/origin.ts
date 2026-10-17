import type { NextFunction, Request, Response } from "express";

/**
 * Origin validation and CORS for browser-based MCP clients.
 *
 * The MCP Streamable HTTP spec requires servers to validate Origin to block
 * DNS-rebinding attacks. Requests without an Origin header (CLI and desktop
 * clients) pass; requests from a browser pass only if their origin is listed
 * in MCP_ALLOWED_ORIGINS, and only those origins get CORS headers.
 */

const ALLOW_HEADERS = "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID";
// Browser clients must be able to read the session id and the 401 challenge.
const EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate";

export function originGuard(allowedOrigins: string[], { reject }: { reject: boolean }) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (!allowed.has(origin)) {
      if (reject) {
        res.status(403).json({ error: "forbidden_origin", error_description: "Origin not allowed" });
      } else {
        next();
      }
      return;
    }
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      "Access-Control-Expose-Headers": EXPOSE_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      Vary: "Origin",
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
