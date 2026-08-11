import type {
  AgentToolBroker,
  AgentToolCallResult,
  AgentToolDescriptor,
  AgentToolMetrics,
} from './contracts.js';

export interface BrowserNavigationPolicy {
  allowedOrigin: string;
  allowedPathPrefixes: readonly string[];
  allowedExactPaths?: readonly string[] | undefined;
}

export interface FixedBrowserProfile {
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  locale: string;
  timezoneId: string;
  colorScheme: 'light' | 'dark' | 'no-preference';
  reducedMotion: 'reduce' | 'no-preference';
}

const policyError = (message: string): AgentToolCallResult => ({
  text: `policy_violation: ${message}`,
  structuredContent: { error: { code: 'policy_violation', message } },
  isError: true,
});

class RestrictedNavigationBroker implements AgentToolBroker {
  readonly #inner: AgentToolBroker;
  readonly #policy: BrowserNavigationPolicy;
  readonly #blockedByTool = new Map<string, number>();
  readonly #violations: string[] = [];

  constructor(inner: AgentToolBroker, policy: BrowserNavigationPolicy) {
    this.#inner = inner;
    this.#policy = policy;
  }

  listTools(): Promise<readonly AgentToolDescriptor[]> {
    return this.#inner.listTools();
  }

  callTool(name: string, input: Record<string, unknown>): Promise<AgentToolCallResult> {
    const isDirectNavigation = name === 'browser_navigate';
    const isNewTabNavigation =
      name === 'browser_tabs' && input['action'] === 'new' && input['url'] !== undefined;
    if (!isDirectNavigation && !isNewTabNavigation) {
      return this.#inner.callTool(name, input);
    }
    const violation = this.#navigationViolation(name, input['url']);
    if (violation === undefined) return this.#inner.callTool(name, input);
    this.#violations.push(violation);
    this.#blockedByTool.set(name, (this.#blockedByTool.get(name) ?? 0) + 1);
    return Promise.resolve(policyError(violation));
  }

  metrics(): AgentToolMetrics {
    const inner = this.#inner.metrics();
    const byTool = new Map(Object.entries(inner.byTool));
    for (const [name, count] of this.#blockedByTool) {
      byTool.set(name, (byTool.get(name) ?? 0) + count);
    }
    return {
      ...inner,
      calls: inner.calls + this.#violations.length,
      errors: inner.errors + this.#violations.length,
      byTool: Object.fromEntries([...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))),
      policyViolations: [...(inner.policyViolations ?? []), ...this.#violations],
    };
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  #navigationViolation(toolName: string, rawUrl: unknown): string | undefined {
    if (typeof rawUrl !== 'string') return `${toolName} blocked malformed URL`;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return `${toolName} blocked malformed URL`;
    }
    if (url.origin !== this.#policy.allowedOrigin) {
      return `${toolName} blocked origin ${url.origin}`;
    }
    const exact = this.#policy.allowedExactPaths?.includes(url.pathname) === true;
    const prefixed = this.#policy.allowedPathPrefixes.some((prefix) =>
      url.pathname.startsWith(prefix),
    );
    if (!exact && !prefixed) return `${toolName} blocked path ${url.pathname}`;
    return undefined;
  }
}

export const restrictBrowserNavigation = (
  inner: AgentToolBroker,
  policy: BrowserNavigationPolicy,
): AgentToolBroker => new RestrictedNavigationBroker(inner, policy);

class FixedBrowserProfileBroker implements AgentToolBroker {
  readonly #inner: AgentToolBroker;
  readonly #profile: FixedBrowserProfile;

  constructor(inner: AgentToolBroker, profile: FixedBrowserProfile) {
    this.#inner = inner;
    this.#profile = profile;
  }

  async listTools(): Promise<readonly AgentToolDescriptor[]> {
    const tools = await this.#inner.listTools();
    return tools.map((tool) =>
      tool.name === 'browser_create'
        ? {
            ...tool,
            description: `${tool.description} The benchmark pins the browser profile to ${this.#profile.viewport.width}x${this.#profile.viewport.height} CSS pixels at ${this.#profile.viewport.deviceScaleFactor}x, locale ${this.#profile.locale}, timezone ${this.#profile.timezoneId}, ${this.#profile.colorScheme} color scheme, and ${this.#profile.reducedMotion} reduced motion; caller-supplied profile values are ignored.`,
          }
        : tool,
    );
  }

  callTool(name: string, input: Record<string, unknown>): Promise<AgentToolCallResult> {
    if (name !== 'browser_create') return this.#inner.callTool(name, input);
    return this.#inner.callTool(name, {
      ...input,
      viewport: {
        width: this.#profile.viewport.width,
        height: this.#profile.viewport.height,
        device_scale_factor: this.#profile.viewport.deviceScaleFactor,
      },
      locale: this.#profile.locale,
      timezone_id: this.#profile.timezoneId,
      color_scheme: this.#profile.colorScheme,
      reduced_motion: this.#profile.reducedMotion === 'reduce',
    });
  }

  metrics(): AgentToolMetrics {
    return this.#inner.metrics();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

/** Force every browser_create call onto the benchmark's declared browser profile. */
export const pinBrowserProfile = (
  inner: AgentToolBroker,
  profile: FixedBrowserProfile,
): AgentToolBroker => new FixedBrowserProfileBroker(inner, profile);
