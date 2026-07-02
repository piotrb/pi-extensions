---
title: Opinions live in data, not in code
category: architecture
severity: high
tags:
  - llm-output
  - ux
  - prompt-injection
  - rule-authoring
  - channels
applies_when:
  - designing a tool, gate, or extension in this repo that surfaces LLM-evaluated text to the user
  - adding guidance to LLM-generated text that will appear in the user's chat
  - writing suffixes, prefixes, or wrapper text around an LLM's response
  - authoring or extending SYSTEM_PROMPT content for a downstream agent
  - building a tool that emits a "you should do X instead" message in response to a condition
---

# Problem

In this repo, when a tool's output is read by both the LLM and the user (block reasons, suggested next steps, redirect hints), opinions about what the user should do next get appended as **code-level constants** to every output of a given shape. The same constant then biases every rule, every gate, every context — including cases where the rule has nothing to do with the suggested action. The bias becomes global, not local to the rule that fired.

The canonical instance is `pi-do-it-right`'s `tool_call` `block.reason` field. The field is shown verbatim to the user in the chat, but the agent (the LLM) reads it to decide what to do next. There is no separate "internal notes" channel — anything that biases the LLM biases the user. A code-level suffix that says "use the appropriate pi extension tool" gets pushed onto every block reason, including blocks where the rule has nothing to do with pi extensions.

# Context

The repo's tools and extensions emit LLM-evaluated text that the user sees in chat. The text is the LLM's verdict on a condition (a rule violation, a permission denial, a routing decision). The user reads it to understand what happened; the LLM reads it to decide what to do next. The same string carries both audiences. The LLM is conditioned on the text — it acts on the guidance embedded in it.

The trap is putting opinions about "what to do next" in the code that emits the text (constant suffixes, hardcoded next-step suggestions, wrapper templates). The fix is to put those opinions in the data the LLM already sees: the rule, the prompt, the user-supplied input.

# Solution

Put per-condition guidance in the data layer, not in code-level constants.

1. **Identify the data layer.** If the LLM's output is conditioned on a user-supplied file (a rules file, a config, a doc), the per-condition guidance belongs in that file — not in a code constant.
2. **Tell the LLM, in the system prompt, to surface the rule's own guidance.** Add an explicit instruction: "If the rule text includes an alternative, mention it in your response. Do not invent alternatives the rule does not mention." This is the only place code-level bias is appropriate — at the meta-level, telling the LLM how to read the data layer.
3. **Remove the constant.** If a constant suffix was added to every output of a given shape, drop it. Replace with an instruction to the LLM (step 2).
4. **Verify the rule file is well-authored.** Document the rule-authoring convention (with and without alternatives) in the README. The contract is: "if the rule cares about an alternative, say so; if not, name the rule and stop."

# Why this works

- **One channel, two audiences.** When both the LLM and the user read the same string, anything that biases the LLM biases the user. There is no general way to separate them inside a single string field. The fix is to keep the channel narrow — emit the rule's verdict, not the verdict plus a code-injected next-step.
- **Code biases every output equally.** A constant suffix appended to every block message pushes that opinion on every rule, every gate, every context. The bias becomes global, not local to the rule that fired. Per-rule bias scales better: a rule file where each rule names its own alternative lets the LLM surface the right hint per case.
- **The user reads what the LLM reads.** If the suffix reveals the prompt-injection layer ("inform the user about this block, then use the appropriate pi extension tool"), the user sees it in their chat. Even when it's technically true, it's awkward. The LLM doesn't need the prompt to be visible to the user; the data layer can carry the guidance without surfacing the meta-instruction.
- **Authoring the rule correctly is the source of truth.** When a user wants a `cat` rule to suggest the `read` tool, they put "use the `read` tool instead" in the rule text. The LLM sees the rule, sees the alternative, surfaces it in the verdict. The code does not need to know which tool to suggest — it just emits the rule's text.

# Prevention

- **Default to no code-level guidance in user-visible text.** The text is the rule's verdict; the next-step is in the rule.
- **The only legitimate code-level guidance is meta-guidance to the LLM.** "If the rule text includes an alternative, mention it." "Match the literal text of the rule." "Do not infer rules not stated." These are about how the LLM reads the data, not about what the user should do next.
- **Reference implementation: `pi-do-it-right`.** See `packages/pi-do-it-right/README.md` "Writing rules" for the live rule-authoring convention. The convention: rules with alternatives say so explicitly; rules without alternatives name the rule and stop. The LLM conditions on the rule text, not on a code-injected suffix.
- **Counter-example: don't be afraid of code-level _evaluation_ logic.** Hardcoded verdicts ("if the command matches X, deny") are fine — they're not user-facing opinions, they're rule evaluation. The line is between evaluation (fine in code) and "what the user/agent should do next" (belongs in data).
