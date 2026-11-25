import { AI_TOOLS } from "../types/ai-tools.js";
import {
  collectSharedHooks,
  collectSkillTemplates,
  resolveBundledSkills,
  resolveCommands,
  resolvePlaceholders,
  resolveSkillsNeutral,
} from "./shared.js";
import { getAllAgents, getHooksConfig } from "../templates/antigravity/index.js";

function resolveAntigravityCommands(): ReturnType<typeof resolveCommands> {
  const ctx = AI_TOOLS.antigravity.templateContext;
  const commands = resolveCommands(ctx);
  if (commands.some((command) => command.name === "start")) return commands;

  // Keep `/start` as a manual fallback even though `.agents/hooks.json` enables
  // SessionStart auto-injection by default — users can disable individual hooks
  // (`"enabled": false`) and still bootstrap manually.
  const start = resolveCommands({ ...ctx, hasHooks: false }).find(
    (command) => command.name === "start",
  );
  return start ? [start, ...commands] : commands;
}

/**
 * The Antigravity (2.0 / IDE / CLI) file set — written at init and diffed by `trellis update`.
 * - `.agent/workflows/` — start + finish-work as slash workflows
 * - `.agents/skills/trellis-{name}/SKILL.md` — shared neutral skills (deduped with Pi/Codex/Gemini)
 * - `.agents/agents/trellis-{name}.md` — custom sub-agent definitions for invoke_subagent
 * - `.agents/hooks/*.py` — shared Python hook scripts
 * - `.agents/hooks.json` — named lifecycle hooks (auto-injection enabled by default, toggleable per hook)
 */
export function collectAntigravityTemplates(): Map<string, string> {
  const files = new Map<string, string>();
  const ctx = AI_TOOLS.antigravity.templateContext;

  for (const command of resolveAntigravityCommands()) {
    files.set(`.agent/workflows/${command.name}.md`, command.content);
  }

  for (const [filePath, content] of collectSkillTemplates(
    ".agents/skills",
    resolveSkillsNeutral(ctx),
    resolveBundledSkills(ctx),
  )) {
    files.set(filePath, content);
  }

  for (const agent of getAllAgents()) {
    files.set(`.agents/agents/${agent.name}.md`, agent.content);
  }

  for (const [k, v] of collectSharedHooks(".agents/hooks", "antigravity")) {
    files.set(k, v);
  }

  files.set(".agents/hooks.json", resolvePlaceholders(getHooksConfig()));

  return files;
}
