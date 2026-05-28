# opencode-ask-manus

This plugin provides a `manus` subagent for delegating complex, multi-step tasks to Manus.

## Usage

The primary agent can delegate to Manus by invoking the subagent:

```
@manus research the latest breaking changes in React 19 and summarise them
```

Or the primary agent will automatically route to `subagent_type: "manus"` when it decides the task warrants Manus's capabilities.

### Two tools are available to the manus subagent:

| Tool | Purpose |
|------|---------|
| `manus_run` | Create a new Manus task and block until it finishes |
| `manus_send` | Send a follow-up message to an existing task (or the default IM agent) |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANUS_API_KEY` | *(required)* | Your Manus API key |
| `MANUS_API_URL` | `https://api.manus.ai/v2` | Override the API base URL |
| `MANUS_POLL_INTERVAL` | `4000` | Polling interval in ms |
| `MANUS_POLL_TIMEOUT` | `600000` | Max wait time in ms (10 min) |
| `MANUS_AGENT_PROFILE` | `standard` | Agent profile: `standard`, `lite`, or `max` |

### Multi-turn conversations

The `task_id` is embedded in the `manus_run` output metadata. Pass it to `manus_send` for follow-ups.

```
First turn:  @manus write a Python script that scrapes Hacker News
Second turn: @manus now add error handling and retry logic
```

Use `task_id: "agent-default-main_task"` to talk to the user's default Manus IM agent instead of creating a new task.
