import { type Plugin } from "@opencode-ai/plugin"
import { run, send } from "./tools/manus"

export const ManusPlugin: Plugin = async () => {
  return {
    tool: {
      manus_run: run,
      manus_send: send,
    },
  }
}
