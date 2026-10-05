import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic, offline provider used only by the real tmux/Pi integration test. */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("subagent-test", {
    api: "subagent-test-api", apiKey: "test-only", baseUrl: "http://unused.invalid",
    models: [{
      id: "mock", name: "Offline mock", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter((m) => m.role === "user").map((m) =>
        typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"));
      const text = `Echo: ${users.join(" | ")}`;
      const output: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "" }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "pending",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      void (async () => {
        try {
          stream.push({ type: "start", partial: output });
          await delay(users.at(-1)?.includes("SLOW") ? 3000 : 100, undefined, { signal: options?.signal });
          if (users.at(-1)?.includes("ERROR")) throw new Error("Deliberate mock failure.");
          if (users.at(-1)?.startsWith("QUESTION")) {
            if (context.messages.at(-1)?.role === "toolResult") throw new Error("Clarification must terminate without another provider request.");
            if (!getCurrentTools(context.messages).some((tool) => tool.name === "ask_question")) throw new Error("ask_question was not exposed.");
            const toolCall = { type: "toolCall" as const, id: "clarification-call", name: "ask_question", arguments: { question: "Which storage backend should I use?" } };
            output.content = [toolCall];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
            output.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message: output });
            return;
          }
          const edit = users.at(-1)?.match(/^WORKTREE_EDIT\s+(\S+)$/);
          if (edit && context.messages.at(-1)?.role !== "toolResult") {
            if (!getCurrentTools(context.messages).some((tool) => tool.name === "write")) throw new Error("write was not exposed.");
            if (!getCurrentSystemPrompt(context.messages).includes("isolated Git worktree")) throw new Error("Worktree instructions were not present.");
            const toolCall = { type: "toolCall" as const, id: "worktree-write", name: "write", arguments: { path: edit[1], content: "worker edit\n" } };
            output.content = [toolCall];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
            output.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message: output });
            return;
          }
          if (users.at(-1)?.includes("SKILL_CHECK") && !getCurrentSystemPrompt(context.messages).includes("PRELOADED_SKILL_INSTRUCTIONS")) {
            throw new Error("Skill instructions were not present in the initial system prompt.");
          }
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          output.content[0] = { type: "text", text };
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: output.stopReason, error: output });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
}
