import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AI_TOOLS } from "../types/ai-tools.js";
import {
  collectSharedHooks,
  collectSkillTemplates,
  resolveBundledSkills,
  resolveCommands,
  resolvePlaceholders,
  resolveSkillsNeutral,
  writeTemplateMap,
} from "./shared.js";
import { getAllAgents, getHooksConfig } from "../templates/antigravity/index.js";

const ANTIGRAVITY_HOOKS_PATH = ".agents/hooks.json";

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
 * Merge Trellis named hooks into an existing `.agents/hooks.json`, preserving
 * all user-defined hooks and any user-toggled `"enabled": false` flags on
 * existing `trellis-*` hooks.
 */
export function mergeAntigravityHooksJson(
  existingContent: string,
  templateContent: string,
): string {
  let existing: unknown;
  let template: unknown;
  try {
    existing = JSON.parse(existingContent);
    template = JSON.parse(templateContent);
  } catch {
    return templateContent;
  }

  if (
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing) ||
    template === null ||
    typeof template !== "object" ||
    Array.isArray(template)
  ) {
    return templateContent;
  }

  const merged: Record<string, unknown> = {
    ...(existing as Record<string, unknown>),
  };

  for (const [hookName, templateSpec] of Object.entries(
    template as Record<string, unknown>,
  )) {
    const prevSpec = merged[hookName];
    if (
      prevSpec !== null &&
      typeof prevSpec === "object" &&
      !Array.isArray(prevSpec) &&
      templateSpec !== null &&
      typeof templateSpec === "object" &&
      !Array.isArray(templateSpec) &&
      typeof (prevSpec as Record<string, unknown>).enabled === "boolean"
    ) {
      merged[hookName] = {
        ...(templateSpec as Record<string, unknown>),
        enabled: (prevSpec as Record<string, unknown>).enabled,
      };
    } else {
      merged[hookName] = templateSpec;
    }
  }

  return JSON.stringify(merged, null, 2) + "\n";
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

  files.set(ANTIGRAVITY_HOOKS_PATH, resolvePlaceholders(getHooksConfig()));

  return files;
}

/**
 * Configure Antigravity at init time. When `.agents/hooks.json` already exists,
 * merges Trellis hooks into it instead of overwriting user-defined hooks.
 */
export async function configureAntigravity(cwd: string): Promise<void> {
  const files = collectAntigravityTemplates();
  const hooksFilePath = path.join(cwd, ...ANTIGRAVITY_HOOKS_PATH.split("/"));
  const templateHooks = files.get(ANTIGRAVITY_HOOKS_PATH);

  let mergedExistingHooks: string | null = null;
  if (templateHooks && existsSync(hooksFilePath)) {
    try {
      const existing = readFileSync(hooksFilePath, "utf-8");
      mergedExistingHooks = mergeAntigravityHooksJson(existing, templateHooks);
      files.delete(ANTIGRAVITY_HOOKS_PATH);
    } catch {
      // Unreadable existing file — fall back to standard writeTemplateMap handling.
    }
  }

  await writeTemplateMap(cwd, files);

  if (mergedExistingHooks !== null) {
    writeFileSync(hooksFilePath, mergedExistingHooks, "utf-8");
  }
}
