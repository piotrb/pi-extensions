import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const MAX_DEPTH = 5
const LOG_FILE = join(homedir(), ".pi", "context-preloader.log")

function log(msg: string): void {
  const ts = new Date().toISOString()
  appendFileSync(LOG_FILE, `${ts}  ${msg}\n`)
}

interface RefNode {
  path: string
  content: string
  children: RefNode[]
  skipped?: "already-loaded" | "unreadable" | "max-depth"
}

/** Extract @path references from a block of text, resolved against a base directory. */
function extractRefs(content: string, cwd: string): string[] {
  const refs: string[] = []
  for (const match of content.matchAll(/@([\w./\\-]+\.\w+)/g)) {
    refs.push(resolve(cwd, match[1]))
  }
  return refs
}

/**
 * Recursively resolve @path references into a tree of RefNodes.
 * - `visited` deduplicates across the full tree
 * - `depth` stops recursion at MAX_DEPTH
 */
function resolveRefs(content: string, cwd: string, visited: Set<string>, depth: number): RefNode[] {
  if (depth > MAX_DEPTH) {
    log(`max depth ${MAX_DEPTH} reached, stopping`)
    return []
  }

  const nodes: RefNode[] = []

  for (const absPath of extractRefs(content, cwd)) {
    if (visited.has(absPath)) {
      log(`skip (already loaded) ${absPath}`)
      nodes.push({ path: absPath, content: "", children: [], skipped: "already-loaded" })
      continue
    }
    visited.add(absPath)

    let fileContent: string
    try {
      fileContent = readFileSync(absPath, "utf8")
      log(`loaded (depth ${depth}) ${absPath}`)
    } catch {
      log(`skip (unreadable) ${absPath}`)
      nodes.push({ path: absPath, content: "", children: [], skipped: "unreadable" })
      continue
    }

    const children = resolveRefs(fileContent, dirname(absPath), visited, depth + 1)
    nodes.push({ path: absPath, content: fileContent, children })
  }

  return nodes
}

/** Flatten a tree of RefNodes into an ordered list for system prompt injection (pre-order). */
function flattenNodes(nodes: RefNode[]): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = []
  for (const node of nodes) {
    if (!node.skipped) {
      result.push({ path: node.path, content: node.content })
    }
    result.push(...flattenNodes(node.children))
  }
  return result
}

/** Render a tree of RefNodes as indented lines with box-drawing connectors. */
function renderTree(nodes: RefNode[], cwd: string, prefix = ""): string[] {
  const lines: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const isLast = i === nodes.length - 1
    const connector = isLast ? "└── " : "├── "
    const childPrefix = prefix + (isLast ? "    " : "│   ")

    const label = relative(cwd, node.path) || node.path
    const suffix =
      node.skipped === "already-loaded"
        ? " (already loaded)"
        : node.skipped === "unreadable"
          ? " (unreadable)"
          : node.skipped === "max-depth"
            ? " (max depth)"
            : ""

    lines.push(`${prefix}${connector}${label}${suffix}`)

    if (node.children.length > 0) {
      lines.push(...renderTree(node.children, cwd, childPrefix))
    }
  }
  return lines
}

/** Find AGENTS.md files pi would load: cwd + parents + ~/.pi/agent/AGENTS.md */
function findAgentsMd(cwd: string): string[] {
  const files: string[] = []
  let dir = cwd
  while (true) {
    const candidate = join(dir, "AGENTS.md")
    if (existsSync(candidate)) files.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const global = join(homedir(), ".pi", "agent", "AGENTS.md")
  if (existsSync(global)) files.push(global)
  return files
}

/**
 * Automatically pre-loads files referenced with @path syntax in AGENTS.md
 * (or any other context files loaded by pi) into the system prompt.
 *
 * Recursively resolves @refs found inside loaded files up to MAX_DEPTH levels deep.
 * Deduplicates across the full resolution tree — a file is only injected once
 * even if referenced from multiple places.
 *
 * On reload, displays a dependency tree of resolved files alongside the [Context] output.
 */
export default function (pi: ExtensionAPI): void {
  let cachedSections: { path: string; content: string }[] | null = null
  let injectedThisSession = false

  pi.on("session_start", () => {
    cachedSections = null
    injectedThisSession = false
  })

  // Fires right after the [Context]/[Skills]/[Extensions] display on startup + reload.
  // Pre-scans @refs and caches for injection.
  pi.on("resources_discover", async (event, ctx) => {
    const cwd = event.cwd
    const agentFiles = findAgentsMd(cwd)
    if (agentFiles.length === 0) {
      log(`no AGENTS.md found in ${cwd}`)
      return
    }

    const visited = new Set<string>()
    // Build one tree per AGENTS.md file (roots = the AGENTS.md files themselves)
    const roots: { label: string; children: RefNode[] }[] = []

    for (const agentsFile of agentFiles) {
      try {
        const content = readFileSync(agentsFile, "utf8")
        const children = resolveRefs(content, dirname(agentsFile), visited, 1)
        roots.push({ label: relative(cwd, agentsFile) || agentsFile, children })
      } catch {
        log(`skip (unreadable) ${agentsFile}`)
      }
    }

    const totalLoaded = [...visited].length
    cachedSections = flattenNodes(roots.flatMap((r) => r.children))

    if (totalLoaded === 0) {
      log("no @refs found in AGENTS.md")
      return
    }

    log(`pre-scanned ${totalLoaded} file(s) on ${event.reason}`)

    // Defer until after Pi's reload sequence calls rebuildChatFromMessages() +
    // showLoadedResources(), which would otherwise wipe anything we add now.
    setTimeout(() => {
      const treeLines: string[] = []
      for (const root of roots) {
        if (root.children.length === 0) continue
        treeLines.push(root.label)
        treeLines.push(...renderTree(root.children, cwd))
      }
      ctx.ui.notify(`[Preloaded @refs]\n${treeLines.join("\n")}`, "info")
    }, 0)
  })

  // Shows the dependency tree on demand.
  pi.registerCommand("preloaded", {
    description: "Show dependency tree of files preloaded from @refs in AGENTS.md",
    handler: (_args, ctx) => {
      if (!cachedSections || cachedSections.length === 0) {
        ctx.ui.notify("context-preloader: no @refs loaded", "info")
        return
      }
      const lines = cachedSections.map((s) => `  ${s.path}`).join("\n")
      ctx.ui.notify(`[Preloaded @refs] (${cachedSections.length} files)\n${lines}`, "info")
    },
  })

  pi.on("before_agent_start", (event) => {
    if (injectedThisSession) return
    injectedThisSession = true

    // Use cached result from resources_discover if available,
    // otherwise fall back to scanning the context files directly.
    let sections = cachedSections

    if (!sections) {
      log("cache miss — scanning context files directly")
      const cwd = event.systemPromptOptions.cwd
      const visited = new Set<string>()
      sections = []
      for (const file of event.systemPromptOptions.contextFiles) {
        const nodes = resolveRefs(file.content, cwd, visited, 1)
        sections.push(...flattenNodes(nodes))
      }
      cachedSections = sections
    }

    if (sections.length === 0) return

    log(`injecting ${sections.length} file(s) into system prompt`)

    const appended = sections.map(({ path, content }) => `\n\n<!-- preloaded: ${path} -->\n${content}`).join("")

    return {
      systemPrompt: event.systemPrompt + appended,
    }
  })
}
