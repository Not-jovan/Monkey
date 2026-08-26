import { z } from "zod";

// Minimal OTLP/HTTP JSON logs payload reader. Codex's Rust exporter posts
// ExportLogsServiceRequest with the configured endpoint used verbatim; every
// attribute value it sends is a typed AnyValue wrapper.
const anyValue = z
  .object({
    stringValue: z.string(),
    intValue: z.union([z.string(), z.number()]),
    doubleValue: z.number(),
    boolValue: z.boolean(),
  })
  .partial();

const keyValue = z.object({
  key: z.string(),
  value: anyValue,
});

const logRecord = z.object({
  timeUnixNano: z.union([z.string(), z.number()]).optional(),
  observedTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  severityText: z.string().optional(),
  eventName: z.string().optional(),
  attributes: z.array(keyValue).default([]),
});

export const otlpLogsPayload = z.object({
  resourceLogs: z
    .array(
      z.object({
        resource: z.object({ attributes: z.array(keyValue).default([]) }).optional(),
        scopeLogs: z
          .array(z.object({ logRecords: z.array(logRecord).default([]) }))
          .default([]),
      }),
    )
    .default([]),
});

function flatten(pairs: z.infer<typeof keyValue>[]) {
  const attributes: Record<string, string | number | boolean> = {};
  for (const { key, value } of pairs) {
    if (value.stringValue !== undefined) attributes[key] = value.stringValue;
    else if (value.intValue !== undefined) attributes[key] = Number(value.intValue);
    else if (value.doubleValue !== undefined) attributes[key] = value.doubleValue;
    else if (value.boolValue !== undefined) attributes[key] = value.boolValue;
  }
  return attributes;
}

function toIsoTime(nano: string | number | undefined) {
  if (nano === undefined) return null;
  const asNumber = Number(nano);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return new Date(asNumber / 1_000_000).toISOString();
}

export function readOtlpLogs(payload: unknown) {
  const parsed = otlpLogsPayload.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const records: {
    resource: Record<string, string | number | boolean>;
    attributes: Record<string, string | number | boolean>;
    timestamp: string | null;
    severity: string | null;
  }[] = [];
  for (const resourceLog of parsed.data.resourceLogs) {
    const resource = flatten(resourceLog.resource?.attributes ?? []);
    for (const scopeLog of resourceLog.scopeLogs) {
      for (const record of scopeLog.logRecords) {
        const attributes = flatten(record.attributes);
        records.push({
          resource,
          attributes,
          // Codex stamps the domain timestamp in event.timestamp; the OTLP
          // record time is when the log was recorded.
          timestamp:
            typeof attributes["event.timestamp"] === "string"
              ? attributes["event.timestamp"]
              : toIsoTime(record.timeUnixNano ?? record.observedTimeUnixNano),
          severity: record.severityText ?? null,
        });
      }
    }
  }
  return records;
}

export type OtlpLogRecord = NonNullable<ReturnType<typeof readOtlpLogs>>[number];
