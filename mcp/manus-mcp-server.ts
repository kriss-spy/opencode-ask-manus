#!/usr/bin/env node
/**
 * manus-mcp-server.ts — MCP server that exposes Manus as opencode tools
 *
 * Use this as a fallback when the custom tool approach doesn't work
 * (e.g., Bun is unavailable or you prefer the MCP path).
 *
 * Install:
 *   npm install @modelcontextprotocol/sdk
 *   # or: bun add @modelcontextprotocol/sdk
 *
 * Run (stdio transport, used by opencode):
 *   MANUS_API_KEY=<key> npx tsx manus-mcp-server.ts
 *   # or: MANUS_API_KEY=<key> bun run manus-mcp-server.ts
 *
 * Register in opencode.json:
 *   "mcp": {
 *     "manus": {
 *       "type": "local",
 *       "command": ["npx", "tsx", "/path/to/manus-mcp-server.ts"],
 *       "environment": { "MANUS_API_KEY": "YOUR_KEY_HERE" }
 *     }
 *   }
 *
 * Optional environment variables:
 *   MANUS_API_URL        — override base URL (default: https://api.manus.ai/v2)
 *   MANUS_POLL_INTERVAL  — polling interval in ms (default: 4000)
 *   MANUS_POLL_TIMEOUT   — max wait time in ms (default: 600000 = 10 min)
 *   MANUS_AGENT_PROFILE  — agent profile: "standard" | "lite" | "max" (default: "standard")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function apiUrl(): string {
  return (process.env.MANUS_API_URL ?? "https://api.manus.ai/v2").replace(/\/$/, "")
}

function apiKey(): string {
  const key = process.env.MANUS_API_KEY
  if (!key) throw new Error("MANUS_API_KEY environment variable is not set.")
  return key
}

function pollInterval(): number {
  return parseInt(process.env.MANUS_POLL_INTERVAL ?? "4000", 10)
}

function pollTimeout(): number {
  return parseInt(process.env.MANUS_POLL_TIMEOUT ?? "600000", 10)
}

function agentProfile(profile?: string): string {
  return profile ?? process.env.MANUS_AGENT_PROFILE ?? "manus-1.6"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Manus API helpers
// ---------------------------------------------------------------------------

interface ManusMessage {
  type: string
  status_update?: {
    agent_status: "running" | "stopped" | "waiting" | "error"
  }
  assistant_message?: { content: string }
  error_message?: { content: string }
}

interface ListMessagesResponse {
  ok: boolean
  messages: ManusMessage[]
  error?: { code: string; message: string }
}

interface CreateTaskResponse {
  ok: boolean
  task_id?: string
  error?: { code: string; message: string }
}

async function manusPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl()}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-manus-api-key": apiKey(),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Manus API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function manusGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${apiUrl()}/${path}?${qs}`, {
    headers: { "x-manus-api-key": apiKey() },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Manus API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function pollUntilDone(taskId: string): Promise<string> {
  const deadline = Date.now() + pollTimeout()
  let seenActive = false

  while (true) {
    if (Date.now() > deadline)
      throw new Error(`Manus task ${taskId} timed out after ${pollTimeout() / 1000}s.`)

    const data = await manusGet<ListMessagesResponse>("task.listMessages", {
      task_id: taskId,
      order: "desc",
      limit: "10",
    })

    if (!data.ok) throw new Error(`task.listMessages failed: ${data.error?.message ?? "unknown"}`)

    const statusEvent = data.messages.find((m) => m.type === "status_update")
    const agentStatus = statusEvent?.status_update?.agent_status

    if (agentStatus && agentStatus !== "stopped" && agentStatus !== "error") seenActive = true
    if (agentStatus === "error") return "error"
    if (agentStatus === "stopped" && (seenActive || data.messages.length > 0)) return "stopped"

    await sleep(pollInterval())
  }
}

async function fetchResult(taskId: string): Promise<string> {
  const data = await manusGet<ListMessagesResponse>("task.listMessages", {
    task_id: taskId,
    order: "desc",
    limit: "100",
  })
  if (!data.ok) throw new Error(`task.listMessages failed: ${data.error?.message ?? "unknown"}`)

  for (const msg of data.messages) {
    if (msg.type === "assistant_message" && msg.assistant_message?.content) {
      return msg.assistant_message.content
    }
  }
  return "(Manus task completed but returned no assistant message.)"
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "manus",
  version: "1.0.0",
})

// Tool: manus_run
server.tool(
  "manus_run",
  "Delegate a task to Manus, an AI agent with its own tools and sandbox. Manus can browse the web, write and execute code, manage files, and perform multi-step research. Each call creates a new task that appears in the user's Manus history. Blocks until Manus finishes.",
  {
    task: z
      .string()
      .describe(
        "Full task description for Manus. Be specific: include goals, constraints, and the exact output format you expect.",
      ),
    project_id: z
      .string()
      .optional()
      .describe("Optional Manus project ID for shared instructions / persistent persona."),
    agent_profile: z
      .string()
      .optional()
      .describe("Manus agent profile. Valid values: manus-1.6, manus-1.6-lite, manus-1.6-max."),
  },
  async ({ task, project_id, agent_profile }) => {
    const created = await manusPost<CreateTaskResponse>("task.create", {
      message: { role: "user", content: task },
      agent_profile: agentProfile(agent_profile),
      ...(project_id ? { project_id } : {}),
    })

    if (!created.ok || !created.task_id) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Failed to create Manus task: ${created.error?.message ?? "unknown"}` }],
      }
    }

    const taskId = created.task_id
    const status = await pollUntilDone(taskId)

    if (status === "error") {
      const data = await manusGet<ListMessagesResponse>("task.listMessages", {
        task_id: taskId,
        order: "desc",
        limit: "20",
      })
      const errMsg = data.messages.find((m) => m.type === "error_message")
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Manus task ${taskId} failed: ${errMsg?.error_message?.content ?? "unknown error"}`,
          },
        ],
      }
    }

    const result = await fetchResult(taskId)
    return {
      content: [
        {
          type: "text" as const,
          text: [`<manus_task id="${taskId}" status="completed">`, result, `</manus_task>`].join("\n"),
        },
      ],
    }
  },
)

// Tool: manus_send
server.tool(
  "manus_send",
  "Send a follow-up message to an existing Manus task and wait for the response. Use the task_id returned by a previous manus_run call. Pass task_id='agent-default-main_task' to message the user's default Manus IM agent.",
  {
    task_id: z
      .string()
      .describe("The Manus task ID to continue. Use 'agent-default-main_task' for the default IM agent."),
    message: z.string().describe("The follow-up message to send."),
  },
  async ({ task_id, message }) => {
    await manusPost("task.sendMessage", {
      task_id,
      message: { role: "user", content: message },
    })

    const status = await pollUntilDone(task_id)

    if (status === "error") {
      const data = await manusGet<ListMessagesResponse>("task.listMessages", {
        task_id,
        order: "desc",
        limit: "20",
      })
      const errMsg = data.messages.find((m) => m.type === "error_message")
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Manus task ${task_id} failed: ${errMsg?.error_message?.content ?? "unknown error"}`,
          },
        ],
      }
    }

    const result = await fetchResult(task_id)
    return {
      content: [
        {
          type: "text" as const,
          text: [`<manus_task id="${task_id}" status="completed">`, result, `</manus_task>`].join("\n"),
        },
      ],
    }
  },
)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
