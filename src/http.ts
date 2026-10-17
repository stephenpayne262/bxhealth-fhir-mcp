import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { healthz, readyzHandler } from "./health.js";
import {
  protectedResourceMetadataHandler,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
} from "./oauth/metadata.js";
import { JwtTokenVerifier } from "./oauth/verifier.js";
import { originGuard } from "./origin.js";
import { createServer } from "./server.js";

/**
 * Streamable HTTP entrypoint.
 *
 * One MCP session == one Server + one transport, held in memory and keyed by
 * the Mcp-Session-Id the transport issues on initialize. That makes this
 * process single-replica by construction: scaling the Deployment past one pod
 * without sticky sessions produces intermittent "session not found" errors,
 * because a follow-up request can land on a pod that never saw the
 * initialize. See the deployment notes before changing replicas.
 *
 * Every /mcp request (POST, GET and DELETE) must carry a valid OAuth access
 * token; there is no unauthenticated mode. A session is bound to the
 * identity that opened it, so a session id alone is never a credential: the
 * MCP spec forbids using sessions for authentication.
 */

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** Identity (issuer, subject, client) of the token that opened the session. */
  owner: string;
}

const sessions = new Map<string, Session>();

function ownerOf(auth: AuthInfo | undefined): string {
  const extra = auth?.extra ?? {};
  return JSON.stringify([extra.iss, extra.sub, auth?.clientId]);
}

/**
 * Looks up a session owned by the caller and marks it active. Clients that
 * vanish without a DELETE would otherwise stay in the map for the life of the
 * pod. A session owned by someone else is reported exactly like a missing
 * one, so a leaked id reveals nothing.
 */
function touchSession(id: string, auth: AuthInfo | undefined): StreamableHTTPServerTransport | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (session.owner !== ownerOf(auth)) {
    console.error(`[http] session ${id} used by a different identity than opened it; rejected`);
    return undefined;
  }
  session.lastSeen = Date.now();
  return session.transport;
}

function sweepIdleSessions(): void {
  const cutoff = Date.now() - config.server.sessionIdleMinutes * 60_000;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) {
      sessions.delete(id);
      void session.transport.close();
      console.error(`[http] session expired (idle): ${id} (${sessions.size} open)`);
    }
  }
}

function sessionIdOf(req: Request): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

export interface AppOptions {
  /** Injectable for tests; defaults to a verifier for the configured issuer. */
  verifier?: JwtTokenVerifier;
}

export function buildApp(options: AppOptions = {}): express.Express {
  const { oauth } = config;
  const publicUrl = config.server.publicUrl;
  // config.ts guarantees both for the http transport; this guards misuse.
  if (!oauth || !publicUrl) {
    throw new Error("The HTTP transport requires OAuth configuration (OAUTH_ISSUER, MCP_PUBLIC_URL).");
  }
  const verifier = options.verifier ?? new JwtTokenVerifier(oauth);
  void verifier.init().catch(() => undefined); // warm up; failures are logged and retried

  const app = express();
  app.disable("x-powered-by");

  // Health endpoints are registered before the JSON body parser and carry no
  // auth: kubelet probes must not depend on either.
  app.get("/healthz", healthz);
  app.get("/readyz", readyzHandler(() => verifier.getStatus()));

  // Protected Resource Metadata is public: it is how an unauthenticated
  // client learns where to log in. Served at the RFC 9728 path for /mcp and
  // at the root form for clients that only try that.
  const metadata = protectedResourceMetadataHandler(publicUrl, oauth);
  const metadataCors = originGuard(config.server.allowedOrigins, { reject: false });
  const metadataPaths = [...new Set([protectedResourceMetadataPath(publicUrl), "/.well-known/oauth-protected-resource"])];
  for (const path of metadataPaths) {
    app.options(path, metadataCors);
    app.get(path, metadataCors, metadata);
  }

  app.use("/mcp", originGuard(config.server.allowedOrigins, { reject: true }));
  app.use(
    "/mcp",
    requireBearerAuth({
      verifier,
      requiredScopes: oauth.requiredScopes,
      resourceMetadataUrl: protectedResourceMetadataUrl(publicUrl),
    })
  );

  app.use(express.json({ limit: "4mb" }));

  // ── POST /mcp: JSON-RPC in, JSON or SSE out ────────────────────────────────
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);

    if (sessionId) {
      const existing = touchSession(sessionId, req.auth);
      if (!existing) {
        res.status(404).json(rpcError(-32001, "Session not found", req.body?.id));
        return;
      }
      await existing.handleRequest(req, res, req.body);
      return;
    }

    // No session yet: only an initialize request may open one.
    if (!isInitializeRequest(req.body)) {
      res
        .status(400)
        .json(rpcError(-32000, "Bad Request: no session, and body is not an initialize request", req.body?.id));
      return;
    }

    if (sessions.size >= config.server.maxSessions) {
      res
        .status(503)
        .json(rpcError(-32000, "Too many open sessions; try again later", (req.body as { id?: unknown }).id));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now(), owner: ownerOf(req.auth) });
        console.error(`[http] session opened: ${id} (${sessions.size} open)`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        console.error(`[http] session closed: ${id} (${sessions.size} open)`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await createServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ── GET /mcp: the SSE stream the client opens after initialize ─────────────
  app.get("/mcp", async (req: Request, res: Response) => {
    const transport = requireSession(req, res);
    if (!transport) return;
    await transport.handleRequest(req, res);
  });

  // ── DELETE /mcp: explicit session teardown ─────────────────────────────────
  app.delete("/mcp", async (req: Request, res: Response) => {
    const transport = requireSession(req, res);
    if (!transport) return;
    await transport.handleRequest(req, res);
  });

  return app;
}

function requireSession(req: Request, res: Response): StreamableHTTPServerTransport | null {
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json(rpcError(-32000, "Bad Request: Mcp-Session-Id header is required"));
    return null;
  }
  const transport = touchSession(sessionId, req.auth);
  if (!transport) {
    res.status(404).json(rpcError(-32001, "Session not found"));
    return null;
  }
  return transport;
}

function rpcError(code: number, message: string, id: unknown = null) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: id ?? null };
}

export function startHttpServer(): void {
  const app = buildApp();
  const { host, port } = config.server;

  const httpServer = app.listen(port, host, () => {
    console.error(`[http] MCP server listening on http://${host}:${port}/mcp`);
    console.error(`[http] FHIR ${config.fhir.version} base: ${config.fhir.baseUrl}`);
    console.error(`[http] OAuth resource ${config.server.publicUrl}, issuer ${config.oauth?.issuer}`);
  });

  // Sweep at a fraction of the idle timeout; unref so it never holds the
  // process open on shutdown.
  const sweepMs = Math.max(60_000, (config.server.sessionIdleMinutes * 60_000) / 4);
  const sweeper = setInterval(sweepIdleSessions, sweepMs);
  sweeper.unref();

  // SSE streams are long-lived; do not let Node time them out mid-stream.
  httpServer.headersTimeout = 0;
  httpServer.requestTimeout = 0;

  const shutdown = (signal: string) => {
    console.error(`[http] ${signal} received, closing ${sessions.size} session(s)`);
    clearInterval(sweeper);
    for (const { transport } of sessions.values()) void transport.close();
    sessions.clear();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
