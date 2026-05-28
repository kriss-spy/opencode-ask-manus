# opencode-ask-manus

An [OpenCode plugin](https://opencode.ai/docs/plugins/) that wraps the [Manus API](https://open.manus.ai/docs) — gives any agent the ability to delegate tasks to Manus, an AI agent with its own tools, sandbox, and web access.

## Installation

### As a plugin (recommended)

**From npm:**
```json
{
  "plugin": ["opencode-ask-manus"]
}
```

**From local files:** copy to your plugin directory:
```bash
cp -r opencode-ask-manus ~/.config/opencode/plugins/opencode-ask-manus
```

### As a custom tool

```bash
cp tools/manus.ts .opencode/tools/manus.ts
```

### As an MCP server (fallback)

```bash
cd mcp && npm install
```

See `mcp/opencode.json` for the MCP registration snippet.

### Set your API key

```bash
export MANUS_API_KEY="your_key_here"
```

## Subagent config

The plugin registers a `manus` subagent scoped to only the Manus tools. Add this to your `opencode.json`:

```json
{
  "tools": { "manus_*": false },
  "agent": {
    "manus": {
      "mode": "subagent",
      "description": "Delegates tasks to Manus.",
      "tools": ["manus_run", "manus_send"]
    }
  }
}
```

## Usage

```
@manus research the latest breaking changes in React 19 and summarise them
```

## Tools

| Tool | Purpose |
|------|---------|
| `manus_run` | Create a new Manus task and block until it finishes |
| `manus_send` | Send a follow-up message to an existing task |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANUS_API_KEY` | *(required)* | Your Manus API key |
| `MANUS_API_URL` | `https://api.manus.ai/v2` | Override the API base URL |
| `MANUS_POLL_INTERVAL` | `4000` | Polling interval in ms |
| `MANUS_POLL_TIMEOUT` | `600000` | Max wait time in ms (10 min) |
| `MANUS_AGENT_PROFILE` | `manus-1.6` | Agent profile: `manus-1.6`, `manus-1.6-lite`, or `manus-1.6-max` |

## Architecture

```
Primary agent → @manus → subagent → manus_run → POST /v2/task.create → Manus cloud
                                              → GET /v2/task.listMessages (poll loop)
                                              → returns <manus_task id="…">…</manus_task>
```
