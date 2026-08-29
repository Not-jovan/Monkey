// Deterministic credential detection, shared by the redaction layer and the
// audit pipeline. Keeping it here means the auditor never needs a model to
// answer "was a secret present" — only "was it relevant to the operation",
// which stays a judged question.

export interface SecretBinding {
  secretType: string;
  value: string;
}

// Key names whose value is a credential by virtue of the name alone.
const secretKeyPatterns = [
  /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PASSPHRASE)/i,
  /(API|ACCESS|SECRET|AUTH|ENCRYPTION|SIGNING|PRIVATE)[_-]?KEY/i,
  /(DATABASE|DB|REDIS|MONGO|POSTGRES|POSTGRESQL|MYSQL|AMQP)[_-]?(URL|URI|DSN|CONNECTION[_-]?STRING)/i,
];

// Values that identify themselves regardless of the name they arrive under —
// a bare `Authorization: Bearer ghp_...` header carries no secret-looking key.
const secretValuePatterns: { secretType: string; pattern: RegExp }[] = [
  { secretType: "GITHUB_TOKEN", pattern: /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/ },
  {
    secretType: "STRIPE_SECRET_KEY",
    pattern: /\bsk_(?:test|live)_[A-Za-z0-9_]{6,}\b/,
  },
  {
    secretType: "ANTHROPIC_API_KEY",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  },
  { secretType: "OPENAI_API_KEY", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { secretType: "ARK_API_KEY", pattern: /\bark-[A-Za-z0-9][A-Za-z0-9-]{14,}\b/ },
  {
    secretType: "AWS_ACCESS_KEY_ID",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    secretType: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/,
  },
  // A connection string carrying inline credentials. The "@" is required so
  // an ordinary URL with a port (https://host:8080/path) is not mistaken for
  // one; credential-bearing DSNs without it are still caught by their key.
  {
    secretType: "DATABASE_URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s"'<>]+/i,
  },
];

// `KEY=value`, optionally `export`-prefixed. Anchored so ordinary source lines
// (`const value: any = getValue()`) cannot masquerade as an assignment.
const assignmentPattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const jsonFieldPattern = /"([A-Za-z_][A-Za-z0-9_.-]*)"\s*:\s*"([^"]*)"/g;
const headerPattern = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+)$/;

const MIN_SECRET_VALUE_LENGTH = 6;
const jsonLiteral = /^(?:true|false|null|-?\d+(?:\.\d+)?)$/i;

function isCredentialValue(value: string) {
  const trimmed = stripQuotes(value);
  if (trimmed.length < MIN_SECRET_VALUE_LENGTH) return false;
  if (jsonLiteral.test(trimmed)) return false;
  return true;
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isSecretKey(key: string) {
  return secretKeyPatterns.some((pattern) => pattern.test(key));
}

// Classifies a value on its own shape, for credentials that arrive unbound.
export function classifySecretValue(value: string): string | null {
  for (const { secretType, pattern } of secretValuePatterns) {
    if (pattern.test(value)) return secretType;
  }
  return null;
}

// Splits text into the smallest units that can hold one assignment: lines, and
// within a line the `&`-joined pairs of a urlencoded request body.
function fragments(text: string) {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    out.push(line);
    if (line.includes("&")) {
      for (const part of line.split("&")) out.push(part);
    }
  }
  return out;
}

// Pulls named credentials out of any text: dotenv assignments, urlencoded
// bodies, JSON fields, and request headers.
export function detectSecretBindings(text: string): SecretBinding[] {
  const found = new Map<string, SecretBinding>();
  const remember = (secretType: string, value: string) => {
    const cleaned = stripQuotes(value);
    if (!isCredentialValue(cleaned)) return;
    if (!found.has(secretType)) found.set(secretType, { secretType, value: cleaned });
  };

  for (const fragment of fragments(text)) {
    const assignment = assignmentPattern.exec(fragment);
    if (assignment && isSecretKey(assignment[1]!)) {
      remember(assignment[1]!, assignment[2]!);
      continue;
    }
    const header = headerPattern.exec(fragment);
    if (header) {
      const inferred = classifySecretValue(header[2]!);
      if (inferred) remember(inferred, extractSecretValue(header[2]!, inferred));
      else if (isSecretKey(header[1]!)) remember(header[1]!, header[2]!);
    }
  }

  jsonFieldPattern.lastIndex = 0;
  let field: RegExpExecArray | null;
  while ((field = jsonFieldPattern.exec(text)) !== null) {
    if (isSecretKey(field[1]!)) remember(field[1]!, field[2]!);
  }

  // Anything that identifies itself by shape, wherever it sits in the text.
  for (const { secretType, pattern } of secretValuePatterns) {
    const match = pattern.exec(text);
    if (match) remember(secretType, match[0]);
  }

  return [...found.values()];
}

// Narrows a header value ("Bearer ghp_x") down to the credential inside it.
function extractSecretValue(text: string, secretType: string) {
  const entry = secretValuePatterns.find(
    (candidate) => candidate.secretType === secretType,
  );
  const match = entry?.pattern.exec(text);
  return match ? match[0] : text;
}

// The redaction layer needs global regexes to mask every occurrence; detection
// needs single-match ones. Sharing the sources keeps masking coverage and
// audit coverage from drifting apart.
export function globalSecretValuePatterns(): RegExp[] {
  return secretValuePatterns.map(
    ({ pattern }) => new RegExp(pattern.source, pattern.flags + "g"),
  );
}
