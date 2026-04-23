/**
 * matrix-channel — Claude Code Channel plugin (MCP stdio server)
 *
 * Polls Matrix rooms and forwards messages into interactive Claude Code sessions.
 * Trusted sender: @ted:claudebox.me only — all other messages are ignored.
 * Permission relay: replies from Ted in #approvals are forwarded to the session.
 */

import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as sdk from "matrix-js-sdk";

// ── Config ──────────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envFile =
    process.env["MATRIX_ENV_FILE"] ||
    process.env["ENV_FILE"] ||
    path.join(process.env["HOME"] || "/home/ted", ".claude-secrets/matrix.env");

  if (!fs.existsSync(envFile)) {
    console.error(`[matrix-channel] ERROR: env file not found: ${envFile}`);
    process.exit(1);
  }

  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const REQUIRED_VARS = ["MATRIX_HOMESERVER_URL", "MATRIX_BOT_USER_ID", "MATRIX_ACCESS_TOKEN"];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`[matrix-channel] ERROR: Required env var '${v}' is missing or empty.`);
    process.exit(1);
  }
}

const HOMESERVER_URL = process.env["MATRIX_HOMESERVER_URL"]!;
const BOT_USER_ID = process.env["MATRIX_BOT_USER_ID"]!;
const ACCESS_TOKEN = process.env["MATRIX_ACCESS_TOKEN"]!;
const TRUSTED_SENDER = "@ted:claudebox.me";
const POLL_INTERVAL_MS = 5000;

// Rooms to watch (name → ID)
const WATCHED_ROOMS: Record<string, string> = {
  "task-queue": process.env["MATRIX_ROOM_TASK_QUEUE"] || "",
  "approvals":  process.env["MATRIX_ROOM_APPROVALS"] || "",
  "announcements": process.env["MATRIX_ROOM_ANNOUNCEMENTS"] || "",
  "dev":        process.env["MATRIX_ROOM_DEV"] || "",
};

// ── Matrix client ────────────────────────────────────────────────────────────

const matrixClient = sdk.createClient({
  baseUrl: HOMESERVER_URL,
  userId: BOT_USER_ID,
  accessToken: ACCESS_TOKEN,
  timelineSupport: false,
});

// ── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "matrix-channel", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: `Matrix channel events arrive as <claude-channel> tags.
Messages from #approvals are task approval requests — respond with approve or reject.
Messages from #task-queue are status updates — no reply needed.
Messages from other rooms are direct communications from Ted.`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "matrix_reply",
      description:
        "Send a reply to a Matrix room. Use to respond to approval requests in #approvals " +
        "or to acknowledge messages from Ted.",
      inputSchema: {
        type: "object",
        properties: {
          room_name: {
            type: "string",
            description: "Short room name (e.g. 'approvals', 'dev')",
          },
          message: { type: "string", description: "Message text to send" },
        },
        required: ["room_name", "message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "matrix_reply") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }

  const { room_name, message } = req.params.arguments as {
    room_name: string;
    message: string;
  };

  const roomId = WATCHED_ROOMS[room_name];
  if (!roomId) {
    const known = Object.keys(WATCHED_ROOMS).join(", ");
    return {
      content: [{ type: "text", text: `Unknown room '${room_name}'. Watched rooms: ${known}` }],
      isError: true,
    };
  }

  try {
    await matrixClient.sendTextMessage(roomId, message);
    return { content: [{ type: "text", text: "sent" }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to send: ${String(err)}` }],
      isError: true,
    };
  }
});

// ── Poller ───────────────────────────────────────────────────────────────────

// since tokens per room (incremental fetch)
const sinceTokens: Record<string, string> = {};

async function pollRoom(roomName: string, roomId: string): Promise<void> {
  if (!roomId) return;

  try {
    const params: Record<string, string | number> = { limit: 20 };
    if (sinceTokens[roomId]) {
      params["from"] = sinceTokens[roomId];
    }

    const resp = await matrixClient.createMessagesRequest(roomId, sinceTokens[roomId] || null, 20, sdk.Direction.Forward);

    if (resp?.end) {
      sinceTokens[roomId] = resp.end;
    }

    for (const event of resp?.chunk || []) {
      if (event.type !== "m.room.message") continue;
      if (event.sender !== TRUSTED_SENDER) continue;

      const body = (event.content as { body?: string })?.body;
      if (!body) continue;

      // Emit as channel event — Claude Code picks this up via the channel capability
      const channelEvent = JSON.stringify({
        type: "matrix_message",
        room: roomName,
        sender: event.sender,
        body,
        event_id: event.event_id,
        timestamp: event.origin_server_ts,
      });

      process.stdout.write(
        `data: <claude-channel>${channelEvent}</claude-channel>\n\n`
      );
    }
  } catch (_err) {
    // Silently skip poll errors — transient network issues should not crash the plugin
  }
}

async function startPolling(): Promise<void> {
  // Seed since tokens with current end of timeline (skip historical messages)
  for (const [name, roomId] of Object.entries(WATCHED_ROOMS)) {
    if (!roomId) continue;
    try {
      const resp = await matrixClient.createMessagesRequest(roomId, null, 1, sdk.Direction.Backward);
      if (resp?.end) {
        sinceTokens[roomId] = resp.end;
      }
    } catch {
      // Room may be empty or inaccessible; start from beginning
    }
  }

  setInterval(async () => {
    for (const [name, roomId] of Object.entries(WATCHED_ROOMS)) {
      await pollRoom(name, roomId);
    }
  }, POLL_INTERVAL_MS);
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start polling after MCP handshake
  await startPolling();
}

main().catch((err) => {
  console.error("[matrix-channel] Fatal:", err);
  process.exit(1);
});
