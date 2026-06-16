import { relative } from "node:path"

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SelectItem } from "@earendil-works/pi-tui"

import type { DirectoryPromptArgs, GrantResult } from "../directory-permissions.ts"

/** Build the SelectItem[] for the directory-permissions modal. */
export function buildDirectoryOptions(args: DirectoryPromptArgs): SelectItem[] {
  const { path, cwd, effectiveTags, grantedTags } = args
  const displayPath = formatDirectoryPath(path, cwd)
  const ungrantedTags = effectiveTags.filter((t) => !grantedTags.includes(t))
  const tagOptions = ungrantedTags.map((tag) => ({
    value: `tag:${tag}`,
    label: `Allow ${tag} on ${displayPath}`,
  }))
  const unionOption =
    ungrantedTags.length > 1 ? [{ value: "union", label: `Allow [${ungrantedTags.join(", ")}] on ${displayPath}` }] : []
  const customOption = [{ value: "custom", label: "Custom path..." }]
  const denyOption = [{ value: "deny", label: "Deny (don't save)" }]
  return [...tagOptions, ...unionOption, ...customOption, ...denyOption]
}

/**
 * Open the directory-permissions prompt. Returns a GrantResult or null (cancel).
 *
 * Uses the same inline `ctx.ui.select` flow as the policy ask prompt: the
 * path/tags render above the options, replacing the input prompt while active.
 * The prompt lists one option per ungranted tag, a union option (when more
 * than one tag is ungranted), a "Custom path..." input, and a "Deny" option.
 */
export async function openDirectoryPermissionsModal(
  ctx: ExtensionContext,
  args: DirectoryPromptArgs,
): Promise<GrantResult | null> {
  const { path, effectiveTags } = args
  const options = buildDirectoryOptions(args)
  const labels = options.map((option) => option.label)
  const chosen = await ctx.ui.select(buildDirectoryTitle(args), labels)
  if (chosen === undefined) return null

  const item = options[labels.indexOf(chosen)]
  if (!item) return null

  if (item.value === "deny") {
    return { decision: "deny", path, tags: [] }
  }
  if (item.value === "union") {
    const ungrantedTags = effectiveTags.filter((t) => !args.grantedTags.includes(t))
    return { decision: "allow", path, tags: ungrantedTags }
  }
  if (item.value === "custom") {
    const customPath = await ctx.ui.input(`Custom path\n\nOriginal: ${path}`, "Path to allow")
    const trimmed = customPath?.trim()
    if (!trimmed) return null
    const ungrantedTags = effectiveTags.filter((t) => !args.grantedTags.includes(t))
    return {
      decision: "custom",
      path: trimmed,
      tags: ungrantedTags,
      customPath: trimmed,
    }
  }
  if (typeof item.value === "string" && item.value.startsWith("tag:")) {
    const tag = item.value.slice(4)
    return { decision: "allow", path, tags: [tag] }
  }
  return null
}

/** Build the prompt title for the inline directory-permissions selector. */
export function buildDirectoryTitle(args: DirectoryPromptArgs): string {
  const tagPart = args.effectiveTags.length > 0 ? args.effectiveTags.join(", ") : "(none)"
  const lines = [
    "Tool is trying to access a path outside the project.",
    `Path: ${formatDirectoryPath(args.path, args.cwd)}`,
  ]
  // When the guardrail asked for a containing directory (because the
  // original tool request targeted a file or a non-existent path), show
  // the original so the user knows what they are actually granting
  // access to. Skipped when the container IS the original (i.e. the
  // tool requested the directory directly).
  if (args.originalPath && args.originalPath !== args.path) {
    lines.push(`Original: \`${args.originalPath}\``)
  }
  lines.push(`Tool tags: ${tagPart}`, "", "Pick an action:")
  return lines.join("\n")
}

/** Render cwd-relative and absolute forms together, e.g. ``../foo` (`/abs/foo`)``. */
export function formatDirectoryPath(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath) || "."
  return `\`${rel}\` (\`${absPath}\`)`
}
