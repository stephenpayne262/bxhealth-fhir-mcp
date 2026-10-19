import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "./config.js";
import { type ToolDefinition, tools } from "./tools.js";

export const SERVER_NAME = "bxhealth-fhir-mcp";
export const SERVER_VERSION = "1.0.0";

/**
 * Builds a fresh MCP Server with the FHIR tool set wired up.
 *
 * A Server instance can only be connected to one transport, and the
 * Streamable HTTP transport is per-session, so the HTTP entrypoint calls
 * this once per session rather than sharing a single module-level server.
 *
 * With MCP_READ_ONLY=true only tools marked readOnly are exposed; the others
 * are absent from tools/list and rejected as unknown if called anyway.
 * Patient scoping (MCP_PATIENT_SCOPED) does the same for tools not marked
 * patientSafe, and passes each handler the caller's patient id.
 */
export function createServer(available: ToolDefinition[] = availableTools()): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: patientScoped()
        ? "All data is limited to the signed-in member's own records. Leave patientId out: every tool " +
          "defaults to the member, and other ids are refused. To get the member's own Patient record, " +
          "search Patient with no parameters."
        : undefined,
    }
  );

  // ── List Tools ──────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: available.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: buildJsonSchema(tool.inputSchema),
        annotations: { readOnlyHint: tool.readOnly },
      })),
    };
  });

  // ── Call Tool ───────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    const tool = available.find((t) => t.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // Validate input
    const parseResult = tool.inputSchema.safeParse(args ?? {});
    if (!parseResult.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters for tool '${name}': ${parseResult.error.message}`
      );
    }

    const started = Date.now();
    try {
      const patient = extra.authInfo?.extra?.patient;
      // The verifier refuses tokens without a patient, so this is a backstop.
      if (patientScoped() && typeof patient !== "string") {
        throw new Error("No patient context in the access token.");
      }
      const result = await tool.handler(parseResult.data, { patient: patientScoped() ? (patient as string) : undefined });
      auditToolCall(extra.authInfo, name, "ok", started);
      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (error: unknown) {
      auditToolCall(extra.authInfo, name, "error", started);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export function availableTools(): ToolDefinition[] {
  return tools.filter((t) => (t.readOnly || !config.tools.readOnly) && (t.patientSafe || !patientScoped()));
}

function patientScoped(): boolean {
  return Boolean(config.oauth?.patientClaim);
}

// ── Audit log ────────────────────────────────────────────────────────────────

/**
 * One JSON line per tool call on stderr: who called what, and how it went.
 * Never the token, and never the arguments, which can carry patient data.
 */
function auditToolCall(auth: AuthInfo | undefined, tool: string, outcome: "ok" | "error", started: number): void {
  console.error(
    JSON.stringify({
      event: "tool_call",
      time: new Date().toISOString(),
      sub: auth?.extra?.sub ?? null,
      client_id: auth?.clientId ?? null,
      tool,
      outcome,
      duration_ms: Date.now() - started,
    })
  );
}

// ── Zod → JSON Schema (simple conversion for MCP) ────────────────────────────

/** Minimal JSON Schema from a Zod schema's `_def`; see CLAUDE.md for the supported types. */
function buildJsonSchema(schema: any): Record<string, unknown> {
  const typeName = schema._def?.typeName as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = schema._def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as any;
        properties[key] = buildJsonSchema(fieldSchema);
        // If not optional/default, mark as required
        if (
          fieldSchema._def?.typeName !== "ZodOptional" &&
          fieldSchema._def?.typeName !== "ZodDefault"
        ) {
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    case "ZodOptional":
      return buildJsonSchema(schema._def.innerType);
    case "ZodDefault": {
      const inner = buildJsonSchema(schema._def.innerType);
      inner.default = schema._def.defaultValue();
      return inner;
    }
    case "ZodString":
      return { type: "string", description: schema.description };
    case "ZodNumber":
      return { type: "number", description: schema.description };
    case "ZodBoolean":
      return { type: "boolean", description: schema.description };
    case "ZodArray":
      return {
        type: "array",
        items: buildJsonSchema(schema._def.type),
        description: schema.description,
      };
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: buildJsonSchema(schema._def.valueType),
        description: schema.description,
      };
    case "ZodEnum":
      return { type: "string", enum: schema._def.values, description: schema.description };
    case "ZodUnion":
      return { oneOf: schema._def.options.map(buildJsonSchema), description: schema.description };
    case "ZodUnknown":
    case "ZodAny":
      return { description: schema.description };
    default:
      return { description: schema.description };
  }
}
