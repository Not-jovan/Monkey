import { describe, expect, it } from "vitest";
import { createRedactor, maskSecret } from "./redaction.js";

describe("maskSecret", () => {
  it("keeps first and last three characters of long secrets", () => {
    expect(maskSecret("abcdef123456789xyz")).toBe("abc************xyz");
  });

  it("fully masks short secrets instead of revealing six of their characters", () => {
    expect(maskSecret("shortkey")).toBe("******");
  });
});

describe("createRedactor", () => {
  // Wholly synthetic: shares no characters with any real credential.
  const arkKey = "ark-EXAMPLE-FAKE-TOKEN-FOR-UNIT-TESTS-001";
  const redactor = createRedactor([arkKey, "hunter2-hunter2"]);

  it("masks configured secret values wherever they appear", () => {
    const masked = redactor.redactText("key=" + arkKey + " done");
    expect(masked).not.toContain(arkKey);
    expect(masked).toContain("ark***");
    expect(masked).toContain("001");
  });

  it("masks every occurrence, not only the first", () => {
    const masked = redactor.redactText(arkKey + " and again " + arkKey);
    expect(masked).not.toContain(arkKey);
    expect(masked.match(/ark\*+/g)).toHaveLength(2);
  });

  it("ignores values too short or multi-line to be maskable", () => {
    const noisy = createRedactor(["true", "line1\nline2"]);
    expect(noisy.redactText("value is true")).toBe("value is true");
  });

  it("catches unknown credentials by shape", () => {
    const stray = "sk-abc123def456ghi789jkl";
    const masked = redactor.redactText("found " + stray + " in env");
    expect(masked).not.toContain(stray);
  });

  it("masks bearer tokens while keeping the scheme readable", () => {
    const masked = redactor.redactText("Authorization: Bearer abcdefgh12345678TOKEN");
    expect(masked).toContain("Bearer ");
    expect(masked).not.toContain("abcdefgh12345678TOKEN");
    expect(masked).toContain("abc");
  });

  it("redacts nested structures without touching non-strings", () => {
    const input = {
      count: 3,
      ok: true,
      output: "leaked " + arkKey,
      steps: [{ note: arkKey }, { note: "clean" }],
    };
    const masked = redactor.redactDeep(input);
    expect(masked.count).toBe(3);
    expect(masked.ok).toBe(true);
    expect(masked.output).not.toContain(arkKey);
    expect(masked.steps[0]?.note).not.toContain(arkKey);
    expect(masked.steps[1]?.note).toBe("clean");
  });

  it("masks the credential shapes the audit pipeline can name", () => {
    const shapes = [
      "ghp_exampleexampleexample",
      "sk_live_exampleexample",
      "postgres://user:password@example.com/db",
    ];
    for (const shape of shapes) {
      expect(redactor.redactText("value " + shape + " end")).not.toContain(
        shape,
      );
    }
  });

  it("leaves an ordinary URL with a port intact", () => {
    const url = "https://example.com:8080/health";
    expect(redactor.redactText("GET " + url)).toContain(url);
  });

  it("prefers longer secrets so substring secrets cannot break masking", () => {
    const layered = createRedactor(["abcdefgh", "abcdefgh-extended-secret"]);
    const masked = layered.redactText("abcdefgh-extended-secret");
    expect(masked).not.toContain("extended");
  });
});
