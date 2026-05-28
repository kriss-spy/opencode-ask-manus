/**
 * manus.ts — opencode custom tool for delegating tasks to Manus
 *
 * Place this file at:
 *   .opencode/tools/manus.ts   (project-local)
 *   ~/.config/opencode/tools/manus.ts  (global)
 *
 * Required environment variable:
 *   MANUS_API_KEY  — from Manus Settings → API Integration
 *
 * Optional environment variables:
 *   MANUS_API_URL        — override base URL (default: https://api.manus.ai/v2)
 *   MANUS_POLL_INTERVAL  — polling interval in ms (default: 4000)
 *   MANUS_POLL_TIMEOUT   — max wait time in ms (default: 600000 = 10 min)
 *   MANUS_AGENT_PROFILE  — agent profile: "standard" | "lite" | "max" (default: "standard")
 */

import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManusMessage {
  type: string
  status_update?: {
    agent_status: "running" | "stopped" | "waiting" | "error"
    status_detail?: {
      waiting_for_event_id?: string
      waiting_for_event_type?: string
      waiting_description?: string
    }
  }
  assistant_message?: {
    content: string
  }
  error_message?: {
    content: string
  }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiUrl(): string {
  return (process.env.MANUS_API_URL ?? "https://api.manus.ai/v2").replace(/\/$/, "")
}

function apiKey(): string {
  const key = process.env.MANUS_API_KEY
  if (!key) throw new Error("MANUS_API_KEY environment variable is not set. Get your key from Manus Settings → API Integration.")
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

function httpRequest(method: string, path: string, body?: unknown): any {
  const url = `${apiUrl()}/${path}`
  const key = apiKey()
  const args = [
    "-s",
    "-w",
    "\n%{http_code}",
    "-X",
    method,
    url,
    "-H",
    "Content-Type: application/json",
    "-H",
    `x-manus-api-key: ${key}`,
  ]
  if (body) args.push("-d", JSON.stringify(body))
  const result = spawnSync("curl", args, { encoding: "utf-8", timeout: 30000 })
  if (result.error) throw new Error(`curl failed: ${result.error.message}`)
  const lines = (result.stdout as string).trim().split("\n")
  const status = parseInt(lines.pop()!, 10)
  const responseBody = lines.join("\n")
  if (status < 200 || status >= 300) {
    throw new Error(`Manus API error ${status} on ${method} ${url} (key: ${key.slice(0, 8)}...): ${responseBody}`)
  }
  return JSON.parse(responseBody)
}

async function manusPost<T>(path: string, body: unknown): Promise<T> {
  return httpRequest("POST", path, body) as T
}

async function manusGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString()
  return httpRequest("GET", `${path}?${qs}`) as T
}

/**
 * Poll task.listMessages until the agent reaches a terminal state.
 * Returns the last known agent_status and the full message list.
 */
async function pollUntilDone(
  taskId: string,
  signal: AbortSignal,
): Promise<{ status: string; messages: ManusMessage[] }> {
  const deadline = Date.now() + pollTimeout()
  let seenActive = false

  while (true) {
    if (signal.aborted) throw new Error("Tool call was aborted.")
    if (Date.now() > deadline) throw new Error(`Manus task ${taskId} timed out after ${pollTimeout() / 1000}s.`)

    const data = await manusGet<ListMessagesResponse>("task.listMessages", {
      task_id: taskId,
      order: "desc",
      limit: "10",
    })

    if (!data.ok) throw new Error(`task.listMessages failed: ${data.error?.message ?? "unknown error"}`)

    const statusEvent = data.messages.find((m) => m.type === "status_update")
    const agentStatus = statusEvent?.status_update?.agent_status

    if (agentStatus && agentStatus !== "stopped" && agentStatus !== "error") {
      seenActive = true
    }

    if (agentStatus === "error") {
      return { status: "error", messages: data.messages }
    }

    if (agentStatus === "stopped" && (seenActive || data.messages.length > 0)) {
      return { status: "stopped", messages: data.messages }
    }

    await sleep(pollInterval())
  }
}

/**
 * Fetch the full message list and extract the last assistant message text.
 */
async function fetchResult(taskId: string): Promise<string> {
  const data = await manusGet<ListMessagesResponse>("task.listMessages", {
    task_id: taskId,
    order: "desc",
    limit: "100",
  })

  if (!data.ok) throw new Error(`task.listMessages failed: ${data.error?.message ?? "unknown error"}`)

  // Walk messages newest-first (order=desc) to find the last assistant message
  for (const msg of data.messages) {
    if (msg.type === "assistant_message" && msg.assistant_message?.content) {
      return msg.assistant_message.content
    }
  }

  return "(Manus task completed but returned no assistant message.)"
}

// ---------------------------------------------------------------------------
// Tool: manus_run  — create a new Manus task and wait for the result
// ---------------------------------------------------------------------------

export const run = tool({
  description: [
    "Delegate a task to Manus, a capable AI agent with its own tools and sandbox.",
    "Manus can browse the web, write and execute code, manage files, and perform multi-step research.",
    "Use this when the task benefits from Manus's full agentic capabilities.",
    "The tool blocks until Manus finishes and returns the final assistant message.",
    "Each call creates a new task that appears in the user's Manus history.",
  ].join(" "),
  args: {
    task: tool.schema
      .string()
      .describe(
        "Full task description for Manus. Be specific: include goals, constraints, and the exact output format you expect back.",
      ),
    project_id: tool.schema
      .string()
      .optional()
      .describe(
        "Optional Manus project ID to attach this task to (for shared instructions / persistent persona).",
      ),
    agent_profile: tool.schema
      .string()
      .optional()
      .describe(
        "Manus agent profile. Valid values: manus-1.6, manus-1.6-lite, manus-1.6-max. Defaults to manus-1.6 or MANUS_AGENT_PROFILE env var.",
      ),
  },
  async execute(args, ctx) {
    ctx.metadata({ title: `Manus: ${args.task.slice(0, 60)}${args.task.length > 60 ? "…" : ""}` })

    // 1. Create task
    const created = await manusPost<CreateTaskResponse>("task.create", {
      message: {
        role: "user",
        content: args.task,
      },
      agent_profile: agentProfile(args.agent_profile),
      ...(args.project_id ? { project_id: args.project_id } : {}),
    })

    if (!created.ok || !created.task_id) {
      throw new Error(`Failed to create Manus task: ${created.error?.message ?? "unknown error"}`)
    }

    const taskId = created.task_id

    // 2. Poll until done
    const { status } = await pollUntilDone(taskId, ctx.abort)

    // 3. Fetch result
    if (status === "error") {
      const data = await manusGet<ListMessagesResponse>("task.listMessages", {
        task_id: taskId,
        order: "desc",
        limit: "20",
      })
      const errMsg = data.messages.find((m) => m.type === "error_message")
      throw new Error(
        `Manus task ${taskId} failed: ${errMsg?.error_message?.content ?? "unknown error"}`,
      )
    }

    const result = await fetchResult(taskId)

    return {
      title: `Manus task ${taskId}`,
      output: [
        `<manus_task id="${taskId}" status="completed">`,
        result,
        `</manus_task>`,
      ].join("\n"),
      metadata: { task_id: taskId, status },
    }
  },
})

// ---------------------------------------------------------------------------
// Tool: manus_send  — continue an existing Manus task / conversation
// ---------------------------------------------------------------------------

export const send = tool({
  description: [
    "Send a follow-up message to an existing Manus task and wait for the response.",
    "Use the task_id returned by a previous manus_run or manus_send call.",
    "Pass task_id='agent-default-main_task' to message the user's default Manus IM agent.",
  ].join(" "),
  args: {
    task_id: tool.schema
      .string()
      .describe("The Manus task ID to continue. Use 'agent-default-main_task' for the default IM agent."),
    message: tool.schema
      .string()
      .describe("The follow-up message to send."),
  },
  async execute(args, ctx) {
    ctx.metadata({ title: `Manus follow-up: ${args.message.slice(0, 50)}…` })

    // Send message to existing task
    await manusPost("task.sendMessage", {
      task_id: args.task_id,
      message: { role: "user", content: args.message },
    })

    // Poll until done
    const { status } = await pollUntilDone(args.task_id, ctx.abort)

    if (status === "error") {
      const data = await manusGet<ListMessagesResponse>("task.listMessages", {
        task_id: args.task_id,
        order: "desc",
        limit: "20",
      })
      const errMsg = data.messages.find((m) => m.type === "error_message")
      throw new Error(
        `Manus task ${args.task_id} failed: ${errMsg?.error_message?.content ?? "unknown error"}`,
      )
    }

    const result = await fetchResult(args.task_id)

    return {
      title: `Manus task ${args.task_id}`,
      output: [
        `<manus_task id="${args.task_id}" status="completed">`,
        result,
        `</manus_task>`,
      ].join("\n"),
      metadata: { task_id: args.task_id, status },
    }
  },
})
