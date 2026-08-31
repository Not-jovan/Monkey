import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  AGENT_RUNTIME: z.enum(["codex", "claude-code"]).default("codex"),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  CLAUDE_CODE_HOME: z.string().default(path.resolve("claude-home")),
  CLAUDE_CODE_BIN: z.string().default("claude"),
  // Claude Code's analog of CODEX_SANDBOX_MODE, with one important
  // difference: Codex sandboxes at the OS level, Claude Code does not
  // sandbox at all — it gates tools behind approval prompts. Under
  // headless `-p` there is nobody to approve, so the default mode denies
  // every Bash command and every file write, and the agent silently does
  // nothing but read. "acceptEdits" frees file edits; only
  // "bypassPermissions" frees commands, and it is only defensible with
  // RUNTIME_PROVIDER=container, where the container is the boundary.
  CLAUDE_CODE_PERMISSION_MODE: z
    .enum(["default", "acceptEdits", "bypassPermissions"])
    .default("acceptEdits"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Subscription credential from `claude setup-token`. Claude Code ranks
  // ANTHROPIC_API_KEY above this, so the two are mutually exclusive in
  // claudeCodeRuntime.processEnv rather than both being forwarded.
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  AUDIT_ENABLED: z.enum(["true", "false"]).default("true"),
  // Comma-separated hostnames the agent may reach. Unset disables the check
  // entirely; an explicit empty value means deny-all. A leading dot opts a
  // whole subtree in (".github.com" covers api.github.com).
  AUDIT_NETWORK_WHITELIST: z.string().optional(),
  // Unset: same model the chat agent uses (ARK_MODEL), else DeepSeek flash.
  AUDIT_SECURITY_MODEL: z.string().optional(),
  AUDIT_INTENT_MODEL: z.string().optional(),
  // Deadline for one audit model call. Streaming makes this a stall budget —
  // the time allowed with no answer text arriving — rather than a cap on how
  // long a whole answer may take, so a long verdict no longer races the clock.
  // Reasoning tokens do not reset it; a model that never leaves thinking dies
  // at this deadline instead of running until the 5x ceiling.
  AUDIT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  // Streaming is what lets the deadline above tell a slow answer from a stuck
  // one. It costs about 1.3x end to end (six alternating eval runs each way:
  // 81.0s streamed against 62.0s not), measured from a dev machine over a WAN
  // hop to Ark; expect less on a server colocated with the endpoint.
  //
  // It also scored slightly better, which is why it is the default rather than
  // a tunable. Over those runs streaming held 95.0% on injected objectives in
  // all six, where non-streamed fell to 90% in two, and streaming disagreed
  // with itself far less run to run (1.7%/0.0% against 6.0%/2.7%). Recall was
  // 100% either way, so nothing is missed by turning this off — but precision
  // and stability both drop a little.
  //
  // Off restores the old behaviour, where the timeout caps total generation
  // time and AUDIT_MODEL_TIMEOUT_MS must be raised to suit.
  AUDIT_MODEL_STREAM: z.enum(["true", "false"]).default("true"),
  // Reasoning models bill thinking as output tokens. On a live audit DeepSeek
  // flash sat in reasoning_content for the full stall budget (4k+ chunks, no
  // JSON) and the step failed. Audits are short JSON, so thinking is off
  // unless AUDIT_MODEL_THINKING=enabled. "auto" is treated as off for the
  // same reason: the provider's default is the stall. Re-measure with
  // `npm run eval:audit` if you turn thinking back on.
  AUDIT_MODEL_THINKING: z
    .enum(["disabled", "enabled", "auto"])
    .default("disabled"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    // Two distinct rejections. Reporting them separately matters: a bootstrap
    // placeholder is usually long enough to pass the length check, so a single
    // message about length sends the operator looking in the wrong place.
    if (authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN is still the placeholder from .env.example. Replace it " +
          "with at least 24 random characters for a non-loopback production server.",
      );
    }
    if (authToken.length < 24) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback " +
          "production server (got " + authToken.length + ").",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    agentRuntime: env.AGENT_RUNTIME,
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    claudeCodeHome: path.resolve(env.CLAUDE_CODE_HOME),
    claudeCodeBin: env.CLAUDE_CODE_BIN,
    claudeCodePermissionMode: env.CLAUDE_CODE_PERMISSION_MODE,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() ?? "",
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? "",
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    auditEnabled: env.AUDIT_ENABLED === "true",
    auditSecurityModel:
      env.AUDIT_SECURITY_MODEL?.trim() ||
      env.ARK_MODEL?.trim() ||
      "deepseek-v4-flash-ga-260731",
    auditIntentModel:
      env.AUDIT_INTENT_MODEL?.trim() ||
      env.ARK_MODEL?.trim() ||
      "deepseek-v4-flash-ga-260731",
    auditModelTimeoutMs: env.AUDIT_MODEL_TIMEOUT_MS,
    auditModelThinking: env.AUDIT_MODEL_THINKING,
    auditModelStream: env.AUDIT_MODEL_STREAM === "true",
    auditNetworkWhitelist:
      env.AUDIT_NETWORK_WHITELIST === undefined
        ? null
        : env.AUDIT_NETWORK_WHITELIST.split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0),
    nodeEnv: env.NODE_ENV,
  };
}

// Values the redaction layer must mask wherever they appear in traces,
// audits, or chat transcripts.
export function secretValues(config: AppConfig): string[] {
  return [
    config.arkApiKey,
    config.authToken,
    config.anthropicApiKey,
    config.claudeCodeOauthToken,
  ].filter((value) => value.length > 0);
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}
