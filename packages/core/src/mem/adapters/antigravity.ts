/**
 * Persisted Antigravity (CLI / 2.0 / IDE) session reader.
 *
 * Layout:
 *   - `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
 *   - `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
 *   - `~/.gemini/antigravity-ide/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
 *   - or `$ANTIGRAVITY_BRAIN_DIR/<conversation-id>/.system_generated/logs/transcript.jsonl`
 *
 * Each line in `transcript.jsonl` is a step object with `type` (`USER_INPUT`,
 * `PLANNER_RESPONSE`, `SYSTEM_MESSAGE`, `GENERIC`, ...), `created_at`,
 * `content`, and optional `tool_calls`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isBootstrapTurn, stripInjectionTags } from "../dialogue.js";
import { inRangeOverlap, sameProject } from "../filter.js";
import { readJsonl } from "../internal/jsonl.js";
import { antigravityBrainRoots } from "../internal/paths.js";
import { parseTaskPyCommandsAll } from "../phase.js";
import { searchInDialogue } from "../search.js";
import type {
  DialogueTurn,
  MemFilter,
  MemSessionInfo,
  SearchHit,
  TaskPyEvent,
} from "../types.js";

interface AntigravityToolCall {
  name?: unknown;
  args?: Record<string, unknown>;
}

interface AntigravityEntry {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  cwd?: unknown;
  workspace_path?: unknown;
  workspacePaths?: unknown;
  tool_calls?: AntigravityToolCall[];
}

interface AntigravityBuilt {
  turns: DialogueTurn[];
  events: TaskPyEvent[];
}

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const META_BLOCK_RE =
  /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g;

function unwrapArgString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* fall through to raw string */
    }
  }
  return trimmed;
}

function cleanUserContent(raw: string): string {
  const match = USER_REQUEST_RE.exec(raw);
  const extracted = match ? match[1] : raw.replace(META_BLOCK_RE, "");
  return stripInjectionTags(extracted).trim();
}

function cleanAssistantContent(raw: string): string {
  return stripInjectionTags(raw).trim();
}

function deriveTitle(firstUserText: string | undefined): string | undefined {
  if (!firstUserText) return undefined;
  const firstLine = firstUserText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function findWorkspaceRootFromPath(candidatePath: string): string | undefined {
  if (!path.isAbsolute(candidatePath)) return undefined;
  // Ignore Antigravity's own app-data / brain / builtin paths when inferring project cwd.
  const normalized = candidatePath.replace(/\\/g, "/");
  if (
    normalized.includes("/.gemini/antigravity") ||
    normalized.includes("/.gemini/config/") ||
    normalized.includes("/.agents/skills/")
  ) {
    return undefined;
  }

  let cur = path.resolve(candidatePath);
  try {
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) {
      cur = path.dirname(cur);
    }
  } catch {
    cur = path.dirname(cur);
  }

  const start = cur;
  while (cur !== path.dirname(cur)) {
    try {
      if (
        fs.existsSync(path.join(cur, ".trellis")) ||
        fs.existsSync(path.join(cur, ".git"))
      ) {
        return cur;
      }
    } catch {
      /* ignore stat failures */
    }
    cur = path.dirname(cur);
  }
  return start;
}

function inferCwdFromEntry(entry: AntigravityEntry): string | undefined {
  if (typeof entry.cwd === "string" && entry.cwd.trim()) {
    return entry.cwd.trim();
  }
  if (typeof entry.workspace_path === "string" && entry.workspace_path.trim()) {
    return entry.workspace_path.trim();
  }
  if (
    Array.isArray(entry.workspacePaths) &&
    typeof entry.workspacePaths[0] === "string" &&
    entry.workspacePaths[0].trim()
  ) {
    return entry.workspacePaths[0].trim();
  }
  if (!Array.isArray(entry.tool_calls)) return undefined;
  for (const call of entry.tool_calls) {
    const args = call?.args;
    if (!args || typeof args !== "object") continue;
    for (const key of ["Path", "path", "Cwd", "cwd", "DirectoryPath"]) {
      const val = unwrapArgString(args[key]);
      if (!val) continue;
      const root = findWorkspaceRootFromPath(val);
      if (root) return root;
    }
  }
  return undefined;
}

function candidateTranscripts(): { id: string; filePath: string }[] {
  const out: { id: string; filePath: string }[] = [];
  const seen = new Set<string>();

  for (const brainRoot of antigravityBrainRoots()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(brainRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcript = path.join(
        brainRoot,
        convId,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      if (!fs.existsSync(transcript)) continue;
      const resolved = path.resolve(transcript);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({ id: convId, filePath: transcript });
    }
  }

  return out;
}

export function antigravityListSessions(f: MemFilter): MemSessionInfo[] {
  const out: MemSessionInfo[] = [];

  for (const { id, filePath } of candidateTranscripts()) {
    let created: string | undefined;
    let updated: string | undefined;
    let cwd: string | undefined;
    let firstUserText: string | undefined;

    readJsonl<AntigravityEntry>(filePath, (entry) => {
      const ts =
        typeof entry.created_at === "string" && entry.created_at.trim()
          ? entry.created_at.trim()
          : undefined;
      if (ts && !created) created = ts;
      if (!cwd) {
        cwd = inferCwdFromEntry(entry);
      }

      if (entry.type === "USER_INPUT" && typeof entry.content === "string") {
        if (ts) updated = ts;
        if (!firstUserText) {
          const cleaned = cleanUserContent(entry.content);
          if (cleaned && !isBootstrapTurn(cleaned, entry.content.length)) {
            firstUserText = cleaned;
          }
        }
        return;
      }

      if (entry.type === "PLANNER_RESPONSE") {
        if (ts) updated = ts;
      }
    });

    if (f.cwd && !sameProject(cwd, f.cwd)) continue;

    if (!updated) {
      try {
        updated = fs.statSync(filePath).mtime.toISOString();
      } catch {
        /* leave undefined */
      }
    }
    if (!inRangeOverlap(created, updated, f)) continue;

    out.push({
      platform: "antigravity",
      id,
      title: deriveTitle(firstUserText),
      cwd,
      created,
      updated,
      filePath,
    });
  }

  return out;
}

export function antigravityExtractDialogue(s: MemSessionInfo): DialogueTurn[] {
  return buildAntigravityTurnsAndEvents(s).turns;
}

export function antigravitySearch(s: MemSessionInfo, kw: string): SearchHit {
  return searchInDialogue(antigravityExtractDialogue(s), kw);
}

export function collectAntigravityTurnsAndEvents(
  s: MemSessionInfo,
): AntigravityBuilt {
  return buildAntigravityTurnsAndEvents(s);
}

function collectTaskEvents(
  entry: AntigravityEntry,
  turnIndex: number,
  events: TaskPyEvent[],
): void {
  if (!Array.isArray(entry.tool_calls)) return;
  for (const call of entry.tool_calls) {
    if (call?.name !== "run_command" && call?.name !== "bash") continue;
    const args = call.args;
    if (!args || typeof args !== "object") continue;
    const command = unwrapArgString(args.CommandLine ?? args.command);
    if (!command) continue;
    for (const parsed of parseTaskPyCommandsAll(command)) {
      events.push({
        turnIndex,
        timestamp: typeof entry.created_at === "string" ? entry.created_at : "",
        ...parsed,
      });
    }
  }
}

function buildAntigravityTurnsAndEvents(s: MemSessionInfo): AntigravityBuilt {
  const turns: DialogueTurn[] = [];
  const events: TaskPyEvent[] = [];

  readJsonl<AntigravityEntry>(s.filePath, (entry) => {
    collectTaskEvents(entry, turns.length, events);

    if (entry.type === "USER_INPUT" && typeof entry.content === "string") {
      const text = cleanUserContent(entry.content);
      if (text && !isBootstrapTurn(text, entry.content.length)) {
        turns.push({ role: "user", text });
      }
      return;
    }

    if (
      entry.type === "PLANNER_RESPONSE" &&
      typeof entry.content === "string"
    ) {
      const text = cleanAssistantContent(entry.content);
      if (text) {
        turns.push({ role: "assistant", text });
      }
    }
  });

  return { turns, events };
}
