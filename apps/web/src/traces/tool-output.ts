// Codex wraps every shell result in a fixed preamble before the actual output:
//
//   Chunk ID: de9266
//   Wall time: 0.0513 seconds
//   Process exited with code 0
//   Original token count: 63
//   Output:
//   total 0
//   drwxr-xr-x ...
//
// That preamble is Codex bookkeeping, not something the operator asked to see,
// and it pushes the real output below the fold. Split it here rather than at
// ingest, so the stored trace keeps the raw text as evidence.

export interface ParsedToolOutput {
  meta: { label: string; value: string }[];
  body: string;
  // False when no envelope was recognised, in which case body is the input
  // unchanged — never drop content just because the shape was unfamiliar.
  stripped: boolean;
}

const LABELLED = new Map<string, string>([
  ["Chunk ID", "chunk"],
  ["Wall time", "wall time"],
  ["Original token count", "tokens"],
  ["Total token count", "tokens"],
  ["Token count", "tokens"],
]);

const EXIT_CODE = /^Process exited with code (-?\d+)$/;
const KEY_VALUE = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/;

export function parseToolOutput(text: string): ParsedToolOutput {
  const lines = text.split(/\r?\n/);
  const meta: { label: string; value: string }[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "Output:") {
      // Everything past the marker is the output the operator wants.
      return {
        meta,
        body: lines.slice(index + 1).join("\n").replace(/^\n+/, ""),
        stripped: true,
      };
    }
    const exit = EXIT_CODE.exec(line);
    if (exit) {
      meta.push({ label: "exit code", value: exit[1]! });
      index += 1;
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    const label = pair ? LABELLED.get(pair[1]!.trim()) : undefined;
    if (pair && label) {
      meta.push({ label, value: pair[2]!.trim() });
      index += 1;
      continue;
    }
    // A line that is not part of the preamble means there is no envelope.
    break;
  }

  return { meta: [], body: text, stripped: false };
}

// The server clips long values before storing them and leaves this marker.
const CLIP_MARKER = /\s*…\[truncated (\d+) chars\]\s*$/;

export function readClipNotice(text: string) {
  const match = CLIP_MARKER.exec(text);
  if (!match) return null;
  return {
    body: text.replace(CLIP_MARKER, ""),
    hiddenChars: Number(match[1]),
  };
}
