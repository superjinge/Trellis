import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAntigravityTemplates } from "../../src/configurators/antigravity.js";
import { collectPiTemplates } from "../../src/configurators/pi.js";
import { configurePlatform } from "../../src/configurators/index.js";
import { scrubNamedHooksJson } from "../../src/utils/uninstall-scrubbers.js";

const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";

describe("Antigravity 2.0 & CLI integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agy-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shares byte-identical .agents/skills/ entries with Pi", () => {
    const agyFiles = collectAntigravityTemplates();
    const piFiles = collectPiTemplates();

    const agySkills = [...agyFiles.entries()].filter(([k]) =>
      k.startsWith(".agents/skills/"),
    );
    expect(agySkills.length).toBeGreaterThan(0);

    for (const [filePath, content] of agySkills) {
      expect(piFiles.get(filePath)).toBe(content);
    }
  });

  it("scrubNamedHooksJson strips only Trellis hooks and preserves user hooks", () => {
    const hooksJson = JSON.stringify(
      {
        "trellis-session-start": {
          enabled: true,
          SessionStart: [
            { type: "command", command: "python3 ./hooks/session-start.py" },
          ],
        },
        "user-custom-lint": {
          enabled: true,
          PostToolUse: [
            {
              matcher: "run_command",
              hooks: [{ type: "command", command: "./scripts/lint.sh" }],
            },
          ],
        },
      },
      null,
      2,
    );

    const res = scrubNamedHooksJson(hooksJson, [
      ".agents/hooks/session-start.py",
    ]);
    expect(res.fullyEmpty).toBe(false);
    const parsed = JSON.parse(res.content) as Record<string, unknown>;
    expect(parsed["trellis-session-start"]).toBeUndefined();
    expect(parsed["user-custom-lint"]).toBeDefined();
  });

  it("executes Antigravity hooks end-to-end with native payload and output schemas", async () => {
    await configurePlatform("antigravity", tmpDir);
    // Copy trellis scripts + workflow.md into the fixture workspace
    const repoRoot = path.resolve(__dirname, "../../../..");
    fs.cpSync(
      path.join(repoRoot, "packages/cli/src/templates/trellis"),
      path.join(tmpDir, ".trellis"),
      { recursive: true },
    );

    const hooksDir = path.join(tmpDir, ".agents", "hooks");
    const convId = "agy-conv-12345";

    // 1. SessionStart emits injectSteps[0].systemMessage.systemMessage
    const ssOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "session-start.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "SessionStart",
        }),
        encoding: "utf-8",
      },
    );
    const ssJson = JSON.parse(ssOut) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    expect(ssJson.injectSteps[0]?.systemMessage.systemMessage).toContain(
      "<session-context>",
    );

    // 2. PreInvocation deduplicates within the same turn and re-injects on a new turn
    // even if invocationNum increases monotonically across turns.
    const piOut1 = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-workflow-state.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreInvocation",
          invocationNum: 1,
          initialNumSteps: 10,
          lastUserInput: "Add new feature",
        }),
        encoding: "utf-8",
      },
    );
    const piJson1 = JSON.parse(piOut1) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    expect(piJson1.injectSteps[0]?.systemMessage.systemMessage).toContain(
      "<workflow-state>",
    );

    const piOut2 = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-workflow-state.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreInvocation",
          invocationNum: 2,
          initialNumSteps: 10,
          lastUserInput: "Add new feature",
        }),
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(piOut2)).toEqual({});

    const piOut3 = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-workflow-state.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreInvocation",
          invocationNum: 3,
          initialNumSteps: 16,
          lastUserInput: "Now write tests",
        }),
        encoding: "utf-8",
      },
    );
    const piJson3 = JSON.parse(piOut3) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    expect(piJson3.injectSteps[0]?.systemMessage.systemMessage).toContain(
      "<workflow-state>",
    );

    // 3. PreToolUse(run_command) writes shell ticket and emits decision=ask
    // (never `{}`, which agy 1.4.1+ / 2.0 denies fail-closed, and never `allow`,
    // which bypasses Desktop App command approval).
    const shellOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-shell-session-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-1",
            name: "run_command",
            args: {
              CommandLine: "python3 ./.trellis/scripts/task.py start 11-25-demo",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(shellOut)).toEqual({ decision: "ask" });

    // Non-task.py run_command also emits decision=ask (never `{}`)
    const shellNoopOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-shell-session-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-1b",
            name: "run_command",
            args: {
              CommandLine: "git status",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(shellNoopOut)).toEqual({ decision: "ask" });
    const ticketsDir = path.join(
      tmpDir,
      ".trellis",
      ".runtime",
      "shell-tickets",
    );
    const tickets = fs.readdirSync(ticketsDir).filter((f) => f.endsWith(".json"));
    expect(tickets.length).toBe(1);
    const firstTicket = tickets[0];
    expect(firstTicket).toBeDefined();
    const ticket = JSON.parse(
      fs.readFileSync(path.join(ticketsDir, firstTicket ?? ""), "utf-8"),
    ) as { context_key: string; platform: string };
    expect(ticket.platform).toBe("antigravity");
    expect(ticket.context_key).toContain("antigravity");

    // 4. PreToolUse(invoke_subagent) overwrites Prompt with injected task context
    const taskDir = path.join(tmpDir, ".trellis", "tasks", "11-25-demo");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({ id: "11-25-demo", title: "Demo", status: "in_progress" }),
    );
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# Demo PRD\nBuild demo.\n");
    fs.writeFileSync(
      path.join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: ".trellis/workflow.md", reason: "workflow" }) + "\n",
    );
    const sessionsDir = path.join(tmpDir, ".trellis", ".runtime", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${ticket.context_key}.json`),
      JSON.stringify({ current_task: ".trellis/tasks/11-25-demo" }),
    );

    const subOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-subagent-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-2",
            name: "invoke_subagent",
            args: {
              TypeName: "trellis-implement",
              Role: "Implementer",
              Prompt: "Implement demo",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    const subJson = JSON.parse(subOut) as {
      decision: string;
      overwrite: { Prompt: string };
    };
    expect(subJson.decision).toBe("allow");
    expect(subJson.overwrite.Prompt).toContain("<!-- trellis-hook-injected -->");
    expect(subJson.overwrite.Prompt).toContain("Build demo.");

    // 5. Non-Trellis built-in subagents return decision=ask (never `{}`)
    const builtinSubOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-subagent-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-3",
            name: "invoke_subagent",
            args: {
              TypeName: "research",
              Role: "Codebase Researcher",
              Prompt: "Search files",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(builtinSubOut)).toEqual({ decision: "ask" });

    // 6. PreToolUse(invoke_subagent) for trellis-research:
    //    (a) active task grants task-local research/ writes and uses Antigravity tool names
    const researchWithTaskOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-subagent-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-4",
            name: "invoke_subagent",
            args: {
              TypeName: "trellis-research",
              Role: "Researcher",
              Prompt: "Investigate hook contracts",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    const researchWithTaskJson = JSON.parse(researchWithTaskOut) as {
      decision: string;
      overwrite: { Prompt: string };
    };
    expect(researchWithTaskJson.decision).toBe("allow");
    expect(researchWithTaskJson.overwrite.Prompt).toContain(
      ".trellis/tasks/11-25-demo/research/*.md",
    );
    expect(researchWithTaskJson.overwrite.Prompt).toContain("`write_file`");
    expect(researchWithTaskJson.overwrite.Prompt).not.toContain("mcp__exa__");

    //    (b) unmatched conversationId does NOT borrow another window's active task
    const researchUnmatchedOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-subagent-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: "agy-conv-other-window",
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-5",
            name: "invoke_subagent",
            args: {
              TypeName: "trellis-research",
              Role: "Researcher",
              Prompt: "Investigate hook contracts",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    const researchUnmatchedJson = JSON.parse(researchUnmatchedOut) as {
      decision: string;
      overwrite: { Prompt: string };
    };
    expect(researchUnmatchedJson.decision).toBe("allow");
    expect(researchUnmatchedJson.overwrite.Prompt).toContain(
      "ask the user where to write output",
    );
    expect(researchUnmatchedJson.overwrite.Prompt).not.toContain(
      ".trellis/tasks/11-25-demo/research",
    );

    //    (c) non-task in-repo directory pointer (e.g. `src`) is rejected with decision=ask
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `${ticket.context_key}.json`),
      JSON.stringify({ current_task: "src" }),
    );
    const researchNonTaskDirOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-subagent-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        input: JSON.stringify({
          conversationId: convId,
          workspacePaths: [tmpDir],
          cwd: tmpDir,
          hookEventName: "PreToolUse",
          toolCall: {
            id: "tc-6",
            name: "invoke_subagent",
            args: {
              TypeName: "trellis-research",
              Role: "Researcher",
              Prompt: "Investigate hook contracts",
            },
          },
        }),
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(researchNonTaskDirOut)).toEqual({ decision: "ask" });

    // 7. TRELLIS_HOOKS=0 early-exit still emits decision=ask on Antigravity PreToolUse
    const disabledShellOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-shell-session-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        env: { ...process.env, TRELLIS_HOOKS: "0" },
        input: "{}",
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(disabledShellOut)).toEqual({ decision: "ask" });

    const disabledSubOut = execFileSync(
      PYTHON_CMD,
      [path.join(hooksDir, "inject-subagent-context.py")],
      {
        cwd: path.join(tmpDir, ".agents"),
        env: { ...process.env, TRELLIS_HOOKS: "0" },
        input: "{}",
        encoding: "utf-8",
      },
    );
    expect(JSON.parse(disabledSubOut)).toEqual({ decision: "ask" });
  });

  it("merges existing .agents/hooks.json on configurePlatform without clobbering user hooks or disabled flags", async () => {
    const hooksPath = path.join(tmpDir, ".agents", "hooks.json");
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          "user-custom-lint": {
            enabled: true,
            PostToolUse: [
              {
                matcher: "run_command",
                hooks: [{ type: "command", command: "./scripts/lint.sh" }],
              },
            ],
          },
          "trellis-workflow-state": {
            enabled: false,
            PreInvocation: [],
          },
        },
        null,
        2,
      ),
    );

    await configurePlatform("antigravity", tmpDir);

    const merged = JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as Record<
      string,
      { enabled?: boolean }
    >;
    expect(merged["user-custom-lint"]).toBeDefined();
    expect(merged["trellis-workflow-state"]?.enabled).toBe(false);
    expect(merged["trellis-session-start"]?.enabled).toBe(true);
    expect(merged["trellis-subagent-context"]?.enabled).toBe(true);
  });
});
