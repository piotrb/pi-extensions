Author a Skill that encodes knowledge from the current coding-agent session into reusable artifacts on disk. The source is the live session itself — the conversation context plus any files generated or modified during execution. The output is one or more persisted, well-structured knowledge files in a fixed project location.

Structure it around this five-step workflow. The steps run in this exact order. Do not skip a step, do not reorder, do not collapse two steps into one. Skipping Load is the most common failure mode — the conventions are not optional.

1. **Load the `learning-management` skill first.** This is a precondition for any write.
   - The loaded skill encodes the conventions you need: storage layout, naming rules, dispatch index, index-sync procedure, and the AGENTS.md reference. Read it end-to-end before you start naming or writing.
   - Apply those conventions. Do not restate them in your output — the loaded skill is the canonical reference, and duplication will drift.
   - If the loaded skill is unavailable or empty, stop and ask the user. Do not invent conventions from memory.
2. **Gather.** Only after Load.
   - Default source is the current session. Reflect on it: what was built, what broke, decisions and reasoning, deviations from plan, outstanding issues, conventions the user explained in chat.
   - Read the artifact files the session produced as concrete evidence.
   - The repository is a secondary source. Use it when the user redirects: names a file path, points at a target area, or provides free-text scope. In that case, read the files the user pointed at plus anything semantically adjacent.
   - Files to consider when the repo is in scope: READMEs, package.json files, AGENTS.md, the project's own skill tree, the diff history, any other files that document conventions.
   - If the user provides direction, follow it.
   - If scope is unclear or too broad, stop and ask the user to narrow it.
3. **Survey.** Only after Load and Gather.
   - Inventory what already exists at the target location so you do not duplicate. Read anything semantically related.
4. **Produce.** Only after Load, Gather, and Survey.
   - Write each piece against a fixed template (named sections, with "omit if not relevant" guidance). Prefer updating an existing artifact over a near-duplicate. Specify strict naming rules — see the loaded `learning-management` skill for the concept-vs-instance test. Before writing, **self-check the name**: would the same name still apply if the rule had surfaced from a different first instance? If yes, the name describes the concept — good. If no, decide whether the specificity is **load-bearing** (the rule only applies inside this repo, this package, this convention) or **a leak** (the rule generalizes but the name accidentally pins it to one instance). Load-bearing specificity is correct — `pi-bfs-do-not-extend` is a valid name if the rule only applies to `pi-bfs`. A leak is when the rule generalizes but the name doesn't show it — then rename to describe the concept.
5. **Report.** Only after Load, Gather, Survey, and Produce.
   - Summarize what changed: each path with a one-line description, note updates vs. creates, and say honestly if nothing was worth encoding.

Bake in: link each artifact back to its source with a relative path (omit when there's no backing source); distinguish kinds of knowledge. **Repo conventions** (e.g. "use `workspace:*` for internal deps in this repo"), **package conventions** (e.g. "`pi-bfs` is transitional, do not extend"), **procedural patterns** (e.g. "the canonical `registerTool` shape"), **domain facts** (e.g. "pi runs on Node 22, ESM, TypeScript strict"), and **project-specific gotchas** (e.g. "skill frontmatter descriptions must not contain colons — see `pi-skill-frontmatter-colon-rule`") are all valid. The template carries whichever applies; a single skill may mix kinds if they cohere around one concept. Gate on reusability — reject one-offs (a single session, a single bug, an event that does not recur), the trivially obvious (well-known to any competent engineer), and the unconfirmed (the user has not verified the rule is real). **Do not** reject on the basis of repo-specificity or package-specificity. A rule that recurs every time someone works in `pi-bfs` is reusable for that package even if it does not generalize to other projects. Specificity is a feature, not a bug — that is exactly what the LLM's base training does not have. State up front what the skill does _not_ do, to keep the executor from over-engineering.

Scope guidance. A learning scoped to one repo, one package, or one tool is valid and often more useful than a generalized version. The LLM's base training does not know "this repo uses X" — that is exactly what the skill should encode. Do not promote a learning to a general concept unless the user asks or the rule clearly recurs across projects.

Keep the skill's own tone brief and purposeful, and have it confirm understanding before writing.
