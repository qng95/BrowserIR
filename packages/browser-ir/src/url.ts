const SENSITIVE_URL_PARAMETER =
  /(?:^|[-_.])(?:access|refresh|id)?[-_.]?token(?:$|[-_.])|(?:^|[-_.])(?:authorization|auth|code|credential|key|password|passwd|pwd|secret|session|jwt|assertion|signature|sig|state|nonce|ticket|otp|saml)(?:$|[-_.])/i;

const redactParameters = (parameters: URLSearchParams): void => {
  for (const key of new Set(parameters.keys())) {
    if (SENSITIVE_URL_PARAMETER.test(key)) {
      parameters.set(key, '[REDACTED]');
    }
  }
};

/**
 * Preserve useful HTTP route context while removing common credential
 * channels before a URL reaches the model-facing representation.
 */
export function sanitizeModelFacingUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'about:') return parsed.href;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${parsed.protocol}[REDACTED]`;
    }

    parsed.username = '';
    parsed.password = '';
    redactParameters(parsed.searchParams);

    const fragment = parsed.hash.slice(1);
    if (fragment.includes('=')) {
      const routeQueryIndex = fragment.indexOf('?');
      if (fragment.startsWith('/') && routeQueryIndex >= 0) {
        const route = fragment.slice(0, routeQueryIndex);
        const parameters = new URLSearchParams(
          fragment.slice(routeQueryIndex + 1),
        );
        redactParameters(parameters);
        parsed.hash = `${route}?${parameters.toString()}`;
      } else if (!fragment.startsWith('/')) {
        const parameters = new URLSearchParams(fragment);
        redactParameters(parameters);
        parsed.hash = parameters.toString();
      }
    }
    return parsed.href;
  } catch {
    return '[unavailable URL]';
  }
}
