/**
 * evaluate — gate a bash command against user-supplied rules via pi's LLM.
 *
 * Uses `@earendil-works/pi-ai`'s `completeSimple`, which handles
 * authentication internally — the extension never touches keys directly.
 * Whatever provider/model the user has configured for pi's main loop is
 * what the gate uses. Auth failures bubble up as a thrown error; the
 * caller fails open.
 *
 * Assembles a short, structured prompt:
 *   - System: instructions + JSON shape contract
 *   - User:   rules + the bash command in a fenced code block
 *
 * Expects the model to return exactly `{ ok: boolean, reason: string }`.
 * Any deviation (parse error, missing fields, model error) is thrown as
 * `EvaluationError` so the caller can fail open.
 *
 * The caller is responsible for:
 *   1. Resolving the model from pi's ModelRegistry (one-time check).
 *   2. Short-circuiting when rules are empty.
 *   3. Failing open when the model cannot be found.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  completeSimple,
  type Context,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
  type UserMessage,
} from "@earendil-works/pi-ai"

export interface EvaluateResult {
  ok: boolean
  reason: string
}

export class EvaluationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = "EvaluationError"
  }
}

/* Output budget: we deliberately do NOT set `maxTokens` on the request.
 * pi-ai's `buildParams` falls back to `model.maxTokens` (the model's own
 * ceiling) when the caller doesn't pass one. Setting a smaller value
 * pits us against providers that ignore `thinking: disabled` and emit
 * thinking blocks anyway — we'd hit `stopReason="length"` mid-reasoning
 * before the JSON verdict lands. Letting the model pick its own
 * ceiling is the honest choice; the gate is fail-open so a runaway
 * conversation can never block the agent. */

/** System prompt — instructs the model to act as a permission gate, not an
 *  approval authority. Adapted from CC hub's gate prompt. */
const SYSTEM_PROMPT = [
  "You are a permission gate that evaluates tool permission requests against a defined ruleset.",
  "",
  "## Your role",
  "",
  "- You NEVER approve requests (returning ok: true simply means no rule matched — the user will still be asked)",
  "- You ONLY auto-reject requests that match a rule, with a clear explanation of the correct alternative",
  "- If no rule matches, return ok: true so the normal permission dialog is shown",
  "",
  "## Rules",
  "",
  "The user-supplied ruleset is provided in the next message. Treat it as a literal",
  "ruleset: each numbered or bulleted item is a single rule. Match the command",
  "against each rule in turn. Do not infer rules that are not stated. Do not",
  "discount rules that look obvious or boilerplate — if the user wrote it, it applies.",
  "",
  "## Rule authoring convention",
  "",
  "Each rule may include its own guidance about what the agent should do",
  "instead — e.g. 'do not use `cat` to read files; use the `read` tool instead'.",
  "When a rule matches and includes that guidance, surface it in the `reason`",
  "field of your response. The block reason is the only thing the user and",
  "the agent see, so it must carry the right 'what to do next' hint.",
  "Do not invent alternatives the rule does not mention. If a rule says only",
  "'do not use X' with no replacement, name the rule and stop.",
  "",
  "## Combining multiple matches into one message",
  "",
  "A single command can violate more than one rule at once (e.g. a pipeline",
  "that uses both `cat` and `rm -rf`). Do not stop at the first match —",
  "check every rule against the full command and collect ALL matches.",
  "Combine them into a single rejection message in the `reason` field:",
  "",
  "- Lead with a short summary naming the violated rules (e.g.",
  '  "Violates rules 3 and 7").',
  "- For each matched rule, include its name and its authored alternative",
  "  (if any), in the same order the rules appear in the ruleset.",
  "- Keep each rule's contribution on its own line or short bullet so",
  "  the agent can read them as a checklist rather than a single dense",
  "  paragraph.",
  "- Personalize the framing when helpful (e.g. the ruleset can carry",
  "  a tone the rules themselves set — mirror it) but never invent",
  "  facts the rules do not state: no extra warnings, no extra",
  "  alternatives, no consequences the rules don't mention.",
  "- If only one rule matches, the reason can be a single line for that",
  "  rule — the same shape, just with one entry.",
  "",
  "## Instructions",
  "",
  "1. Read the proposed bash command carefully.",
  "2. Check every rule in the ruleset against the actual command.",
  "3. If one or more rules match, return ok: false with a `reason` that",
  "   combines the matched rules' messages into a single amalgamate",
  "   rejection (see 'Combining multiple matches into one message').",
  "   Personalize the framing where the ruleset suggests a tone, but",
  "   never add guidance the rules do not contain.",
  '4. If no rules match, return ok: true with reason: "No rules matched".',
  "",
  "If unsure, return ok: true.",
  "",
  "Respond with ONLY a raw JSON object. Do NOT wrap it in markdown code fences (no ```json).",
  "Do NOT add any text before or after the JSON. The response must start with { and end with }:",
  '{"ok": true|false, "reason": "..."}',
].join("\n")

/**
 * Build the user message. The rules and the command are both in fenced
 * code blocks so the model can't confuse one for the other.
 */
function buildUserMessage(rules: string, command: string): string {
  return ["## Rules", "```", rules, "```", "", "## Bash command", "```", command, "```"].join("\n")
}

/** Options to forward to `completeSimple`. Subset of `SimpleStreamOptions`
 *  relevant to a one-off gate call. */
export interface EvaluateOptions {
  signal?: AbortSignal
  apiKey?: string
  headers?: Record<string, string>
  maxTokens?: number
}

/**
 * Gate a bash command against the rules.
 *
 * Throws `EvaluationError` on any error path:
 *   - `completeSimple` rejects (auth, network, rate limit, etc.)
 *   - response has no text block
 *   - JSON parse error or missing fields
 *
 * The caller MUST catch and treat any throw as "fail open".
 *
 * @param rules   The concatenated rules markdown.
 * @param command The full bash command the agent is about to run.
 * @param model   The model resolved from pi's ModelRegistry.
 * @param options Eval call options. `signal` for cancellation;
 *                `apiKey` + `headers` from the registry. When omitted,
 *                pi-ai's simple variants fall back to env vars only.
 * @param deps    Optional injection seam for tests.
 */
export async function evaluate<TApi extends Api = Api>(
  rules: string,
  command: string,
  model: Model<TApi>,
  options: EvaluateOptions = {},
  deps: EvaluateDeps<TApi> = {},
): Promise<EvaluateResult> {
  return runEvaluation(rules, command, model, options, deps, undefined)
}

/**
 * Like `evaluate`, but invokes `onEvent` for each streamed event. Lets
 * the caller render live progress (text deltas, thinking presence) —
 * useful when latency is high or when the user wants to see why the
 * model made a particular verdict.
 *
 * `onEvent` may throw; the throw is converted into an `EvaluationError`
 * so the caller has a single failure path. Pass `undefined` for
 * `onEvent` via `evaluate()` instead.
 */
export async function evaluateStream<TApi extends Api = Api>(
  rules: string,
  command: string,
  model: Model<TApi>,
  options: EvaluateOptions = {},
  onEvent: (event: AssistantMessageEvent) => void,
  deps: EvaluateDeps<TApi> = {},
): Promise<EvaluateResult> {
  return runEvaluation(rules, command, model, options, deps, onEvent)
}

/** Internal driver. Drives the stream, optionally invoking onEvent for
 *  each event, and returns the parsed `EvaluateResult`. */
async function runEvaluation<TApi extends Api = Api>(
  rules: string,
  command: string,
  model: Model<TApi>,
  options: EvaluateOptions,
  deps: EvaluateDeps<TApi>,
  onEvent: ((event: AssistantMessageEvent) => void) | undefined,
): Promise<EvaluateResult> {
  const completeFn = deps.completeSimple ?? completeSimple
  const streamFn = deps.streamSimple ?? streamSimple

  const userMessage: UserMessage = {
    role: "user",
    content: buildUserMessage(rules, command),
    timestamp: Date.now(),
  }

  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [userMessage],
  }

  const simpleOptions: SimpleStreamOptions = {
    // `maxTokens` is intentionally not set — see the file-level
    // comment. Callers may pass `options.maxTokens` to override, but
    // the default is to let the model pick its own ceiling.
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }

  // One HTTP request, two consumers. We call `stream()` once and
  // observe events live (when `onEvent` is provided) while concurrently
  // awaiting `result()` for the final `AssistantMessage`. Calling both
  // `stream()` AND `complete()` would issue duplicate requests and
  // mismatch tokens in the widget vs the verdict.
  const eventStream = (onEvent ? streamFn : completeFn)(model, context, simpleOptions)
  const isAsyncIterable = Symbol.asyncIterator in (eventStream as object)

  let finalResultPromise: Promise<AssistantMessage>
  if (isAsyncIterable) {
    finalResultPromise = (
      eventStream as AsyncIterable<AssistantMessageEvent> & {
        result: () => Promise<AssistantMessage>
      }
    ).result()
  } else {
    finalResultPromise = eventStream as Promise<AssistantMessage>
  }

  if (onEvent && isAsyncIterable) {
    void consumeEvents(eventStream as AsyncIterable<AssistantMessageEvent>, onEvent).catch(() => {
      // Event-consumption errors are best-effort — final result surfaces
      // failures via EvaluationError.
    })
  }

  let response: AssistantMessage
  try {
    response = await finalResultPromise
  } catch (err) {
    throw new EvaluationError("model call failed", err)
  }

  // complete() does not throw on transport errors — those arrive as a
  // finalized AssistantMessage with stopReason "error" / "aborted" and
  // an errorMessage. Surface them as EvaluationError so the caller can
  // fail open with a useful diagnostic instead of seeing a misleading
  // "missing text block" complaint about an empty content array.
  if (response.stopReason !== "stop") {
    const detail = response.errorMessage ? `: ${response.errorMessage}` : ""
    throw new EvaluationError(`model returned stopReason=${response.stopReason}${detail}`)
  }

  return parseResponse(response)
}

/** Drive the event iterator, calling `onEvent` for each non-terminal
 *  event. The terminal `done`/`error` events are filtered — the main
 *  completion promise handles those via `response.stopReason` and
 *  `errorMessage`. */
async function consumeEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  onEvent: (event: AssistantMessageEvent) => void,
): Promise<void> {
  for await (const event of events) {
    if (event.type === "done" || event.type === "error") continue
    onEvent(event)
  }
}

/** Test injection seam. Lets tests supply a stub `completeSimple` that
 *  returns a controlled `AssistantMessage` without hitting the network.
 *  `streamSimple` overrides the parallel streaming consumer used by
 *  `evaluateStream`. */
export interface EvaluateDeps<TApi extends Api = Api> {
  completeSimple?: (model: Model<TApi>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>
  streamSimple?: (
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AsyncIterable<AssistantMessageEvent>
}

/** Find the first text block in an AssistantMessage. */
function extractText(response: AssistantMessage): string | undefined {
  for (const block of response.content) {
    if (block.type === "text") return block.text
  }
  return undefined
}

function parseResponse(response: AssistantMessage): EvaluateResult {
  const text = extractText(response)
  if (!text) {
    const types = response.content.map((b) => b.type).join(",") || "(empty)"
    throw new EvaluationError(`response had no text block (got content types: ${types})`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFences(text))
  } catch (err) {
    throw new EvaluationError("text block is not valid JSON", err)
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new EvaluationError("parsed payload is not an object")
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.ok !== "boolean") {
    throw new EvaluationError('payload missing boolean "ok"')
  }
  if (typeof obj.reason !== "string") {
    throw new EvaluationError('payload missing string "reason"')
  }

  return { ok: obj.ok, reason: obj.reason }
}

/** Strip ```json ... ``` or ``` ... ``` wrappers from a string. */
function stripCodeFences(s: string): string {
  const trimmed = s.trim()
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed)
  const inner = m?.[1]
  return inner !== undefined ? inner.trim() : trimmed
}
