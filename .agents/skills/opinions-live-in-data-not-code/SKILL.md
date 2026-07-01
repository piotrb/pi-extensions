---
name: opinions-live-in-data-not-code
description: When a piece of code emits text that will be read by both an LLM and a human, opinions about "what to do next" belong in the data (the rule, the prompt, the user-supplied file), not in code-level constants. Use when designing any extension or tool that surfaces LLM-evaluated text to the user.
---

# Opinions live in data, not in code

When a tool's output is **read by both an LLM and a human** — block reasons, suggested next steps, redirect hints — opinions about what the user should do next belong in the **data the LLM sees** (the rule, the user-supplied input, the prompt) rather than in **code-level constants** appended to every output.

The hard case is the same channel carrying both audiences. pi's `tool_call` block `reason` field is shown verbatim to the user in the chat, but the agent (the LLM) reads it to decide what to do next. There is no separate "internal notes" channel.

## When to Use

Lead with the symptom: "I added a helpful suffix to the LLM's response and now the user sees it in the chat, even though it was meant for the agent." Use this skill when:

- Adding guidance to LLM-generated text that will be surfaced to the user.
- Writing suffixes, prefixes, or wrapper text around an LLM's response.
- Authoring or extending `SYSTEM_PROMPT` content for a downstream agent.
- Building a tool that emits a "you should do X instead" message in response to a condition.

## Key Facts

- **One channel, two audiences.** When both the LLM and the user read the same string, anything that biases the LLM biases the user. There is no general way to separate them inside a single string field.
- **Code biases every output equally.** A constant suffix appended to every block message ("use pfs*\* instead of bash") pushes that opinion on every rule, every gate, every context — including cases where the rule has nothing to do with `pfs*\*`or`bash`. The bias becomes global, not local to the rule that fired.
- **Per-rule bias scales better than global bias.** A rule file where each rule names its own alternative lets the LLM surface the right hint per case. A code-level suffix that picks a single alternative forces the same hint everywhere.
- **The user reads what the LLM reads.** If the suffix is "inform the user about this block, then use the appropriate pi extension tool", the user sees "inform the user about this block" in their chat. Even when it's technically true, it's awkward and reveals the prompt-injection layer.
- **Authoring the rule correctly is the source of truth.** When a user wants a `cat` rule to suggest the `read` tool, they put "use the `read` tool instead" in the rule text. The LLM sees the rule, sees the alternative, surfaces it in the verdict. The code does not need to know which tool to suggest.

## Steps

1. **Identify the data layer.** If the LLM's output is conditioned on a user-supplied file (a rules file, a config, a doc), the per-condition guidance belongs in that file — not in a code constant.
2. **Tell the LLM, in the system prompt, to surface the rule's own guidance.** Add an explicit instruction: "If the rule text includes an alternative, mention it in your response. Do not invent alternatives the rule does not mention." This is the only place code-level bias is appropriate.
3. **Remove the constant.** If a constant suffix was added to every output of a given shape, drop it. Replace with an instruction to the LLM.
4. **Verify the rule file is well-authored.** Document the rule-authoring convention (with and without alternatives) in the README. The contract is: "if the rule cares about an alternative, say so; if not, name the rule and stop."

## Notes

- This principle applies beyond pi. Anywhere a piece of code generates text for both human and LLM consumption (chat UIs, agent runtimes, multi-agent systems), the bias lives in the data layer.
- The opposite trap is also real: putting guidance in code that should be in the data. e.g. a hardcoded "always prefer tool X" in a wrapper function. The same fix applies — lift it to the layer where the LLM (or the user) can see the relevant context.
- This is not a rule against code-level guidance. The system prompt itself is a legitimate place for: "match the literal text of the rule," "do not infer rules not stated," "if unsure, return ok: true." Those are about the _evaluation_, not about what the user should do next.
- Surfaced in the implementation of `pi-do-it-right` — see `packages/pi-do-it-right/README.md` "Writing rules" for the live authoring convention.
