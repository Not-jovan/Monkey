import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/codex-failure.json" with { type: "json" };
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
