import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/codex-failure.json" with { type: "json" };
import nested from "./__fixtures__/codex-failure-nested.json" with { type: "json" };
import { parseCodexFailure, readCommand } from "./codex-error";

// The fixture is a verbatim capture of a real Codex 0.111.0 exec_command
// failure. Testing against invented input would only prove the parser matches
// my idea of the format.
const RAW = fixture.output;

describe("parseCodexFailure", () => {
  const failure = parseCodexFailure(RAW);

  it("recognises the envelope", () => {
    expect(failure).not.toBeNull();
    expect(failure?.tool).toBe("exec_command");
    expect(failure?.kind).toBe("SandboxDenied");
    expect(failure?.exitCode).toBe(1);
  });

  it("surfaces the thrown error and the missing binary as separate problems", () => {
    // Two independent causes: the sandbox refused the bind, and curl is absent
    // from the runtime image. Reporting only one would send you chasing half.
    expect(failure?.problems[0]).toBe(
      "Error: listen EPERM: operation not permitted 0.0.0.0:3000",
    );
    expect(failure?.problems.some((line) => line.includes("curl: command not found"))).toBe(
      true,
    );
  });

  it("extracts the runtime facts the message states inline", () => {
    const facts = Object.fromEntries(
      (failure?.facts ?? []).map((fact) => [fact.label, fact.value]),
    );
    expect(facts).toMatchObject({
      code: "EPERM",
      syscall: "listen",
      address: "0.0.0.0",
      port: "3000",
    });
  });

  it("separates stack frames from the problem lines", () => {
    expect(failure?.stack.length).toBeGreaterThan(5);
    expect(failure?.stack.every((frame) => frame.startsWith("at "))).toBe(true);
    expect(failure?.problems.some((line) => line.startsWith("at "))).toBe(false);
  });

  it("collapses the payload Codex repeats across message, stderr and aggregated_output", () => {
    // The same ~1.2k payload appears more than once in the raw envelope; the
    // parsed view must not show a stack frame three times.
    const frames = failure?.stack ?? [];
    expect(new Set(frames).size).toBe(frames.length);
    const rendered =
      (failure?.problems.join("\n") ?? "") + "\n" + frames.join("\n");
    expect(rendered.length).toBeLessThan(RAW.length);
  });

  it("unescapes the newlines Codex wrote as literal backslash-n", () => {
    expect(RAW).not.toContain("\n");
    for (const frame of failure?.stack ?? []) {
      expect(frame).not.toContain("\\n");
    }
  });

  it("returns null for text that is not a failure envelope", () => {
    expect(parseCodexFailure("total 0\ndrwxr-xr-x 1 node node 4096 .")).toBeNull();
    expect(parseCodexFailure("")).toBeNull();
    expect(parseCodexFailure("Error: something went wrong")).toBeNull();
  });

  it("survives a truncated envelope rather than throwing", () => {
    const half = RAW.slice(0, Math.floor(RAW.length / 2));
    expect(() => parseCodexFailure(half)).not.toThrow();
    expect(parseCodexFailure(half)?.kind).toBe("SandboxDenied");
  });
});

// Codex changed the envelope: the same denial now arrives wrapped one level
// deeper, as CreateProcess { message: "Codex(Sandbox(Denied { ... }))" }, so
// every payload is escaped twice. The parser silently degraded — duplicate
// stack frames, a stray backslash on every line, and no problem lines at all
// for the shorter denial. Both shapes are pinned here so a fix for one cannot
// quietly break the other.
describe("parseCodexFailure against the nested envelope", () => {
  const portBind = parseCodexFailure(nested.portBind.output);
  const etcWrite = parseCodexFailure(nested.etcWrite.output);

  it("reports the inner cause rather than the outer mechanism", () => {
    // The header says CreateProcess, which is how it failed, not why.
    expect(nested.portBind.output).toContain("CreateProcess");
    expect(portBind?.kind).toBe("SandboxDenied");
    expect(portBind?.tool).toBe("exec_command");
    expect(portBind?.exitCode).toBe(1);
  });

  it("unescapes a payload that was escaped twice", () => {
    expect(portBind?.problems).toContain(
      "Error: listen EPERM: operation not permitted 0.0.0.0:8080",
    );
    // The old chain of replaces left a backslash before every newline, which
    // is what broke the end-anchored problem patterns.
    for (const problem of portBind?.problems ?? []) {
      expect(problem.endsWith("\\")).toBe(false);
    }
    for (const frame of portBind?.stack ?? []) {
      expect(frame.endsWith("\\")).toBe(false);
    }
  });

  it("still collapses the repeated payload", () => {
    // stderr and aggregated_output carry the same 12-frame trace.
    expect(portBind?.stack).toHaveLength(12);
    expect(new Set(portBind?.stack).size).toBe(portBind?.stack.length);
  });

  it("diagnoses a denial that carries no stack trace at all", () => {
    // This one produced nothing before: no problems, no facts, no frames, and
    // the whole payload dumped into "other output" — strictly worse than raw.
    expect(etcWrite?.problems).toEqual([
      "/bin/bash: line 1: /etc/launchpad-probe.txt: Permission denied",
    ]);
    expect(etcWrite?.rest.trim()).toBe("");
  });

  it("leaves far less unclassified than the raw envelope", () => {
    expect(portBind?.rest.length).toBeLessThan(
      nested.portBind.output.length / 4,
    );
  });
});

describe("readCommand", () => {
  it("returns the shell script as real lines", () => {
    const command = readCommand(fixture.arguments);
    expect(command).not.toBeNull();
    // Stored escaped, so it rendered as one unreadable line before this.
    expect(fixture.arguments).not.toContain("\n");
    expect((command ?? "").split("\n").length).toBeGreaterThan(5);
    expect(command).not.toContain("\\n");
    expect(command).toContain("node server.js");
  });

  it("accepts the array form of a command", () => {
    expect(readCommand('{"command":["bash","-lc","ls -la"]}')).toBe(
      "bash -lc ls -la",
    );
  });

  it("returns null when there is no command to show", () => {
    expect(readCommand("not json")).toBeNull();
    expect(readCommand('{"path":"/tmp/x"}')).toBeNull();
    expect(readCommand("[1,2,3]")).toBeNull();
  });
});
