import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
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
  AUDIT_SECURITY_MODEL: z.string().default("gpt-oss-120b-250805"),
  AUDIT_INTENT_MODEL: z.string().default("deepseek-v4-flash-ga-260731"),
  // Override for setups where the Runtime cannot reach the control plane via
  // the derived host (e.g. rootless engines without host-gateway support).
  OTEL_COLLECTOR_URL: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
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
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
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
    auditSecurityModel: env.AUDIT_SECURITY_MODEL.trim(),
    auditIntentModel: env.AUDIT_INTENT_MODEL.trim(),
    otelCollectorUrl: env.OTEL_COLLECTOR_URL?.replace(/\/+$/, "") ?? "",
    nodeEnv: env.NODE_ENV,
  };
}

// Values the redaction layer must mask wherever they appear in traces,
// audits, or chat transcripts.
export function secretValues(config: AppConfig): string[] {
  return [config.arkApiKey, config.authToken].filter((value) => value.length > 0);
}

export function collectorLogsUrl(config: AppConfig): string {
  if (config.otelCollectorUrl) {
    return config.otelCollectorUrl + "/collector/v1/logs";
  }
  // The Runtime container reaches the control plane through the Docker host
  // alias; the local-process runner shares the host loopback.
  const host =
    config.runtimeProvider === "container" ? "host.docker.internal" : "127.0.0.1";
  return "http://" + host + ":" + config.port + "/collector/v1/logs";
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(
  config: AppConfig,
  collectorToken = "",
): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    "[otel]",
    "environment = " + JSON.stringify(config.nodeEnv),
    // Prompts are captured deliberately; the collector masks secrets before
    // anything is persisted or displayed.
    "log_user_prompt = true",
    // Codex 0.111.0 defaults metrics to its own Statsig endpoint; keep all
    // telemetry on this machine.
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "",
    "[otel.exporter.otlp-http]",
    "endpoint = " + JSON.stringify(collectorLogsUrl(config)),
    'protocol = "json"',
    "",
    "[otel.exporter.otlp-http.headers]",
    '"x-collector-token" = ' + JSON.stringify(collectorToken),
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
