/**
 * pi-core-tools — bfs, ripgrep, git, task-runner, context-preloader
 *
 * A collection of structured tool extensions for the pi coding agent.
 * extension-utils is a shared internal utility module, not a tool itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import bfs from "./src/bfs.ts";
import contextPreloader from "./src/context-preloader.ts";
import git from "./src/git.ts";
import ripgrep from "./src/ripgrep.ts";
import taskRunner from "./src/task-runner.ts";

export default function (pi: ExtensionAPI): void {
  bfs(pi);
  contextPreloader(pi);
  git(pi);
  ripgrep(pi);
  taskRunner(pi);
}
