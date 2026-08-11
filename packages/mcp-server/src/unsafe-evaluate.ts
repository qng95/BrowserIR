import {
  MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES,
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
  sanitizeModelFacingUrl,
  type JsonValue,
} from '@browserir/core';

export const DEFAULT_UNSAFE_EVALUATE_TIMEOUT_MS = 2_000;
export const DEFAULT_UNSAFE_EVALUATE_OUTPUT_BYTES = 8 * 1024;
export {
  MAX_UNSAFE_EVALUATE_EXPRESSION_BYTES,
  MAX_UNSAFE_EVALUATE_EXPRESSION_CHARACTERS,
  MAX_UNSAFE_EVALUATE_OUTPUT_BYTES,
  MAX_UNSAFE_EVALUATE_TIMEOUT_MS,
};

const SENSITIVE_KEY =
  /(?:^|[-_.\s])(?:password|passwd|pwd|passcode|passphrase|pin|otp|one[-_.\s]?time|secret|token|authorization|credential|api[-_.\s]?key|private[-_.\s]?key|cookie|session|jwt|assertion|signature|ticket|cvv|cvc|card[-_.\s]?number)(?:$|[-_.\s])/i;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g;
const COMMON_API_TOKEN = /\b(?:sk|pk|api)[-_](?:live|test)?[-_]?[A-Za-z0-9_-]{12,}\b/gi;

export interface RedactedEvaluationValue {
  value: JsonValue;
  redactionCount: number;
}

function redactString(input: string): RedactedEvaluationValue {
  let redactionCount = 0;
  let value = input.replace(BEARER_TOKEN, () => {
    redactionCount += 1;
    return 'Bearer [REDACTED]';
  });
  value = value.replace(JWT_TOKEN, () => {
    redactionCount += 1;
    return '[REDACTED]';
  });
  value = value.replace(COMMON_API_TOKEN, () => {
    redactionCount += 1;
    return '[REDACTED]';
  });
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const sanitized = sanitizeModelFacingUrl(value);
      if (sanitized !== value) redactionCount += 1;
      value = sanitized;
    }
  } catch {
    // Ordinary strings are not URLs and need no URL-specific handling.
  }
  return { value, redactionCount };
}

export function redactUnsafeEvaluationValue(
  input: JsonValue,
): RedactedEvaluationValue {
  if (typeof input === 'string') return redactString(input);
  if (input === null || typeof input !== 'object') {
    return { value: input, redactionCount: 0 };
  }
  if (Array.isArray(input)) {
    let redactionCount = 0;
    const value = input.map((item) => {
      const redacted = redactUnsafeEvaluationValue(item);
      redactionCount += redacted.redactionCount;
      return redacted.value;
    });
    return { value, redactionCount };
  }

  let redactionCount = 0;
  const value: Record<string, JsonValue> = Object.create(null);
  for (const [key, item] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) {
      value[key] = '[REDACTED]';
      redactionCount += 1;
      continue;
    }
    const redacted = redactUnsafeEvaluationValue(item);
    value[key] = redacted.value;
    redactionCount += redacted.redactionCount;
  }
  return { value, redactionCount };
}
