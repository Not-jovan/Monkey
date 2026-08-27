import { describe, expect, it } from "vitest";
import { parseToolOutput, readClipNotice } from "./tool-output";

// The preamble shape is Codex's, captured from a real exec_command result.
const ENVELOPE = [
  "Chunk ID: de9266",
  "Wall time: 0.0513 seconds",
  "Process exited with code 0",
  "Original token count: 63",
  "Output:",
  "total 0",
  "drwxr-xr-x 1 node node 4096 Aug 27 16:01 .",
  "-rw-r--r-- 1 node node  143 Aug 27 16:01 README.md",
].join("\n");

describe("parseToolOutput", () => {
  it("lifts the preamble out and leaves the real output as the body", () => {
    const parsed = parseToolOutput(ENVELOPE);
    expect(parsed.stripped).toBe(true);
    expect(parsed.body.split("\n")[0]).toBe("total 0");
    expect(parsed.body).not.toContain("Chunk ID");
    expect(parsed.body).not.toContain("Output:");
  });

  it("keeps the preamble as labelled facts", () => {
    const facts = Object.fromEntries(
      parseToolOutput(ENVELOPE).meta.map((entry) => [entry.label, entry.value]),
    );
    expect(facts).toEqual({
      chunk: "de9266",
      "wall time": "0.0513 seconds",
      "exit code": "0",
      tokens: "63",
    });
  });

  it("reports a non-zero exit rather than silently dropping it", () => {
    const failed = ENVELOPE.replace(
      "Process exited with code 0",
      "Process exited with code 127",
    );
    expect(parseToolOutput(failed).meta).toContainEqual({
      label: "exit code",
      value: "127",
    });
  });

  it("returns unfamiliar text untouched instead of guessing", () => {
    // Losing output because the shape was unexpected would be worse than
    // showing a preamble.
    const plain = "just some output\nwith two lines";
    const parsed = parseToolOutput(plain);
    expect(parsed.stripped).toBe(false);
    expect(parsed.body).toBe(plain);
    expect(parsed.meta).toEqual([]);
  });

  it("does not mistake output that merely mentions a colon for a preamble", () => {
    const tricky = "note: this is the first line\nsecond line";
    const parsed = parseToolOutput(tricky);
    expect(parsed.stripped).toBe(false);
    expect(parsed.body).toBe(tricky);
  });

  it("keeps an empty body when the command printed nothing", () => {
    const parsed = parseToolOutput("Process exited with code 0\nOutput:\n");
    expect(parsed.stripped).toBe(true);
    expect(parsed.body).toBe("");
  });
});

describe("readClipNotice", () => {
  it("separates the collector's truncation marker from the value", () => {
    const notice = readClipNotice("abc …[truncated 120 chars]");
    expect(notice).toEqual({ body: "abc", hiddenChars: 120 });
  });

  it("returns null when nothing was clipped", () => {
    expect(readClipNotice("abc")).toBeNull();
    // A marker in the middle is part of the content, not the collector's.
    expect(readClipNotice("…[truncated 5 chars] trailing text")).toBeNull();
  });
});
