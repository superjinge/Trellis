import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  antigravityExtractDialogue,
  antigravityListSessions,
  antigravitySearch,
  collectAntigravityTurnsAndEvents,
} from "../../src/mem/adapters/antigravity.js";

describe("antigravity mem adapter", () => {
  let tmpRoot: string;
  let brainDir: string;
  let projectDir: string;
  let prevBrainEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-mem-agy-"));
    brainDir = path.join(tmpRoot, "brain");
    projectDir = path.join(tmpRoot, "repo");
    fs.mkdirSync(path.join(projectDir, ".trellis"), { recursive: true });
    prevBrainEnv = process.env.ANTIGRAVITY_BRAIN_DIR;
    process.env.ANTIGRAVITY_BRAIN_DIR = brainDir;
  });

  afterEach(() => {
    if (prevBrainEnv === undefined) {
      delete process.env.ANTIGRAVITY_BRAIN_DIR;
    } else {
      process.env.ANTIGRAVITY_BRAIN_DIR = prevBrainEnv;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeTranscript(convId: string, entries: object[]): string {
    const logsDir = path.join(brainDir, convId, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf-8",
    );
    return filePath;
  }

  it("discovers sessions, infers project cwd, strips USER_REQUEST tags, and extracts task events", () => {
    const targetFile = path.join(projectDir, "src", "app.ts");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "export const x = 1;\n");

    writeTranscript("conv-agy-1", [
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-25T09:00:00Z",
        content:
          "<USER_REQUEST>\nImplement Antigravity hooks support\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-25T17:00:00+08:00.\n</ADDITIONAL_METADATA>",
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-25T09:01:00Z",
        thinking: "internal reasoning should not leak into dialogue",
        tool_calls: [
          {
            name: "read_file",
            args: { Path: JSON.stringify(targetFile) },
          },
          {
            name: "run_command",
            args: {
              CommandLine: JSON.stringify(
                'python3 ./.trellis/scripts/task.py create "Antigravity hooks" --slug agy-hooks',
              ),
            },
          },
        ],
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-25T09:02:00Z",
        content: "Created task and drafted hooks.json for Antigravity.",
      },
    ]);

    const sessions = antigravityListSessions({ cwd: projectDir });
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.platform).toBe("antigravity");
    expect(session.id).toBe("conv-agy-1");
    expect(session.title).toBe("Implement Antigravity hooks support");
    expect(session.cwd).toBe(path.resolve(projectDir));
    expect(session.created).toBe("2026-11-25T09:00:00Z");
    expect(session.updated).toBe("2026-11-25T09:02:00Z");

    const { turns, events } = collectAntigravityTurnsAndEvents(session);
    expect(turns).toEqual([
      { role: "user", text: "Implement Antigravity hooks support" },
      {
        role: "assistant",
        text: "Created task and drafted hooks.json for Antigravity.",
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("create");

    const hit = antigravitySearch(session, "hooks.json");
    expect(hit.count).toBeGreaterThan(0);
    expect(antigravityExtractDialogue(session)).toHaveLength(2);
  });

  it("filters out sessions belonging to other projects", () => {
    const otherRepo = path.join(tmpRoot, "other-repo");
    fs.mkdirSync(path.join(otherRepo, ".git"), { recursive: true });
    writeTranscript("conv-other", [
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-25T09:00:00Z",
        cwd: otherRepo,
        content: "<USER_REQUEST>\nOther repo work\n</USER_REQUEST>",
      },
    ]);

    expect(antigravityListSessions({ cwd: projectDir })).toHaveLength(0);
    expect(antigravityListSessions({})).toHaveLength(1);
  });
});
