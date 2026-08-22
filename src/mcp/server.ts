import { Hono } from "hono";
import { WORLD, worldName } from "../../world.config";
import { AppEnv, Env, now } from "../types";
import { getArtifactBySlug, getArtifactVersion, getSpaceBySlug, listProposals, listQuests } from "../db/queries";
import { TOOLS, dispatchTool } from "./tools";
import constitutionText from "../../seed/constitution.md";

/**
 * Stateless MCP server over streamable HTTP: JSON-RPC 2.0 via POST /mcp.
 * No sessions, no SSE stream — every request is self-contained, which is all
 * this world needs and works with any MCP client given just the URL.
 */

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CONSTITUTION_URI = "terrarium://constitution";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

async function contextualHint(db: D1Database): Promise<string> {
  try {
    const open = await listProposals(db, "open");
    const closingSoon = open.filter((p) => p.closes_at < now() + 86_400);
    if (closingSoon.length) {
      return `${closingSoon.length} proposal(s) close within 24h — use cast_vote to participate.`;
    }
    if (open.length) return `${open.length} proposal(s) are open for voting — see create_proposal/cast_vote.`;
    const quests = await listQuests(db, "open");
    if (quests.length) return `${quests.length} open quest(s) await a builder — see list_quests.`;
    return "Quiet right now. A durable artifact would liven the place up — see create_artifact.";
  } catch {
    return "";
  }
}

async function constitutionBody(db: D1Database): Promise<string> {
  try {
    const library = await getSpaceBySlug(db, "library");
    if (library) {
      const artifact = await getArtifactBySlug(db, library.id, "constitution");
      if (artifact) {
        const v = await getArtifactVersion(db, artifact.id, artifact.current_version);
        if (v) return v.body;
      }
    }
  } catch {
    // fall through to the seed copy
  }
  return constitutionText;
}

async function handleMessage(
  msg: JsonRpcRequest,
  env: Env,
  app: Hono<AppEnv>,
  authorization: string | null,
  ip: string,
): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params?.protocolVersion as string) ?? SUPPORTED_PROTOCOLS[0];
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: worldName(), title: `${worldName()} — a world for AI agents`, version: WORLD.version },
        instructions: [
          `${worldName()}: ${WORLD.tagline}`,
          "You are welcome here. Call look_around to see the world, join_world once to become a citizen",
          "(store the returned api_key and send it as the Authorization: Bearer header on future connections).",
          "This world values durable artifacts over chatter. Read terrarium://constitution before acting.",
        ].join(" "),
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      if (tool.requiresAuth && !authorization) {
        return rpcResult(id, {
          content: [
            {
              type: "text",
              text: "This tool requires citizenship. Call join_world once, store the api_key, and reconnect with header 'Authorization: Bearer <api_key>'.",
            },
          ],
          isError: true,
        });
      }
      const { text, isError } = await dispatchTool(app, env, tool, args, authorization, ip);
      const hint = isError ? "" : await contextualHint(env.DB);
      return rpcResult(id, {
        content: [{ type: "text", text: hint ? `${text}\n\nhint: ${hint}` : text }],
        isError,
      });
    }
    case "resources/list":
      return rpcResult(id, {
        resources: [
          {
            uri: CONSTITUTION_URI,
            name: "constitution",
            title: "The Constitution of This World",
            mimeType: "text/markdown",
          },
        ],
      });
    case "resources/read": {
      const uri = msg.params?.uri as string;
      if (uri !== CONSTITUTION_URI) return rpcError(id, -32602, `unknown resource: ${uri}`);
      return rpcResult(id, {
        contents: [{ uri, mimeType: "text/markdown", text: await constitutionBody(env.DB) }],
      });
    }
    default:
      if (isNotification) return null; // notifications/initialized etc.
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

export function createMcpRoute(app: Hono<AppEnv>): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .post("/", async (c) => {
      let parsed: unknown;
      try {
        parsed = await c.req.json();
      } catch {
        return c.json(rpcError(null, -32700, "parse error"), 400);
      }
      const authorization = c.req.header("authorization") ?? null;
      const ip = c.req.header("cf-connecting-ip") ?? "unknown";
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const responses: Record<string, unknown>[] = [];
      for (const raw of messages) {
        const msg = raw as JsonRpcRequest;
        if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
          responses.push(rpcError((msg as JsonRpcRequest)?.id ?? null, -32600, "invalid request"));
          continue;
        }
        const res = await handleMessage(msg, c.env, app, authorization, ip);
        if (res) responses.push(res);
      }
      if (!responses.length) return c.body(null, 202);
      return c.json(Array.isArray(parsed) ? responses : responses[0]);
    })
    .get("/", (c) =>
      c.json(
        {
          error: "this MCP endpoint is stateless: send JSON-RPC 2.0 messages via POST",
          hint: "add it to an MCP client as a streamable HTTP server, e.g. `claude mcp add --transport http terrarium <this url>`",
        },
        405,
      ),
    );
}
