# Security policy

## Supported release

BrowserIR 0.1 is an unreleased alpha development line. Security fixes are currently made only on the latest 0.1 source. No long-term support window or response-time SLA is promised yet.

## Deployment scope

The public 0.1 security boundary is one local MCP connection over stdio. The stock `browserir-mcp` executable:

- starts no network listener;
- launches a local, isolated Playwright browser context;
- owns and closes the browser sessions created through that connection; and
- rejects legacy MCP protocol handling.

One stdio connection is limited to four owned or in-flight browsers. The
maintained Playwright backend retains at most 32 pages per browser and analyzes
at most 64 documents per observation. Screenshots are limited to 8,294,400
physical pixels and 16 MiB of encoded image data. These are availability
guards, not tenant isolation or a complete resource-control system.

Browser pages still make network requests, and MCP clients can ask the browser to navigate. Local stdio does not make browsing itself safe.

The source tree contains an embeddable MCP handler, but BrowserIR 0.1 makes no security claim for exposing it over remote HTTP, placing it behind a proxy, sharing it between tenants, or running it as a public service. A remote deployment needs independent authentication, authorization, request limits, tenant isolation, browser isolation, audit, and network policy.

## Arbitrary code execution

BrowserIR should make arbitrary code unnecessary for normal browser-agent work.
Typed actions and explicit capabilities are the supported path. The experimental
`browser_evaluate_unsafe` tool is an escape hatch and is completely absent from
the default nine-tool catalog.

The stock CLI exposes the tool only with the explicit
`--enable-unsafe-evaluate` startup flag. Embedding hosts must separately provide
the runtime service's `unsafeEvaluate` option with a required redacted audit
callback and enable the MCP registration flag. Omitting either layer prevents
the tool from being registered. Do not enable it for an untrusted MCP client or
an untrusted site.

Enabled evaluation is arbitrary JavaScript in the selected Chromium page's
main/default world. It does not execute in the MCP server's Node.js context, but
it can read and exfiltrate page and session data, issue authenticated requests,
mutate DOM state and browser storage, register or alter service workers,
navigate, and open popups. Page-context execution and local stdio are not a
sandbox or an authorization boundary. Isolate the browser process and enforce
navigation and egress policy outside BrowserIR.

The DevTools evaluation path can bypass the page's `script-src` restriction for
this explicitly supplied expression. Content Security Policy is therefore not
a containment boundary for an enabled `browser_evaluate_unsafe` call.

The public request boundary requires an explicit `page_id` and current
`expected_revision`, and applies all of these limits:

- source: at most 16,384 characters and 32 KiB of UTF-8;
- execution: 2 seconds by default and a 5-second hard maximum;
- serialized JSON result: 8 KiB by default and a 64 KiB hard maximum, reduced
  further when necessary to fit the model-result budget; and
- bounded JSON serialization; unsupported, cyclic, over-deep, or oversized
  values fail without returning a partial raw object.

Timeout, request cancellation, and an unacknowledged evaluation-command failure
use Chromium DevTools Protocol termination. BrowserIR never retries an
evaluation. If termination cannot be confirmed, the driver requests and verifies
target closure. If neither can be confirmed, it irreversibly invalidates the
logical browser before returning and attempts bounded best-effort physical
shutdown. After a dispatched evaluation whose browser remains usable, BrowserIR
performs a full observation, forces the page revision to advance, and makes all
previous entity references stale. A post-evaluation observation failure
invalidates the browser. Containment failure skips observation because the
browser has already been invalidated.

Every enabled service requires intent and completion audit records. An intent
audit failure blocks dispatch; a completion audit failure after dispatch
invalidates the browser. Audit records include the selected browser and page,
revisions, limits, timing, outcome, termination/verification status, and only a
SHA-256 digest plus byte length for the source. They never contain source text
or the returned result. The stock CLI writes these metadata records to stderr.

Returned JSON receives heuristic redaction for familiar secret keys, token
shapes, and sensitive URL components. That minimization is not general
data-loss prevention: unknown business secrets, personal data, cookies,
network traffic, and values deliberately encoded or exfiltrated by the supplied
code can still escape. A SHA-256 source digest also provides identification,
not secrecy or proof that the source was safe.

## Trust model for pages

All page-derived content is untrusted, including:

- visible text, labels, descriptions, validation messages, and tooltips;
- ARIA metadata and custom-element properties;
- links and navigation targets;
- filenames and downloaded content;
- screenshots; and
- text that looks like an instruction to the AI agent.

A page can attempt prompt injection. The BrowserIR representation reports interface facts; it does not certify that page content is truthful or authorized. The host agent must keep system policy, user intent, and page content in separate trust domains. It should require confirmation for sensitive or irreversible operations and must not grant privileges merely because a page asks for them.

BrowserIR inspects limited framework metadata as evidence for roleless click targets. It does not invoke or serialize page event handlers, and action targets remain in a private driver registry rather than page-visible attributes. These controls reduce interference; they do not turn an untrusted page into trusted code.

## Navigation and SSRF

The MCP schema accepts only `http:` and `https:` navigation URLs. That is input validation, not an SSRF defense. Chromium can still reach hosts available from the machine running BrowserIR, including localhost, private address ranges, cloud metadata endpoints, and internal applications unless the host prevents it.

The embedding host is responsible for navigation policy. Depending on the deployment, that should include:

- an allowlist of schemes, hosts, ports, and redirect destinations;
- DNS rebinding defenses and IP-range checks after resolution;
- network egress isolation for the browser process;
- blocking cloud metadata and local administration endpoints;
- limits on navigation count, time, response size, and redirects; and
- a policy for links opened by page scripts, popups, and form submissions.

Do not expose BrowserIR to a less-trusted user while giving its browser access to a more-trusted network.

## Credentials, cookies, and authentication profiles

The stock 0.1 CLI does not accept a persisted authentication profile or Playwright storage-state file. Authentication performed in the browser remains in that browser context until it is closed.

Treat credentials, cookies, one-time codes, session tokens, and future auth-profile files as secrets:

- do not commit them to the repository;
- do not place them in task text, logs, screenshots, or benchmark artifacts unless the environment is disposable;
- avoid passing secrets on a command line where process listings can expose them;
- use a dedicated least-privilege account for automation;
- isolate production and test profiles;
- close the BrowserIR session when the task is complete; and
- rotate a credential if it appears in an MCP transcript or capture.

As defense in depth, BrowserIR omits values and perceptible text from native or
custom fields with strong password, one-time-code, payment-secret, API-key, or
token evidence. It also removes URL user information and redacts values of
known sensitive query and fragment parameters before a URL becomes
model-facing. This is heuristic minimization, not a general data-loss
prevention guarantee. Unknown business secrets, page text, network traffic,
cookies, and screenshot pixels can still contain sensitive data.

If a custom host adds profile persistence, it owns encryption at rest, filesystem permissions, retention, tenant separation, and secure deletion. BrowserIR 0.1 does not provide those controls.

## Screenshots, uploads, and downloads

`browser_capture` returns PNG bytes to the connected MCP client. A screenshot can contain passwords, personal information, customer records, access tokens, or other regulated data. The stock CLI does not write captures to disk, but the MCP client may retain them. The client and host are responsible for access control, redaction, encryption, retention, and deletion.

The public upload action accepts opaque artifact IDs, not arbitrary filesystem paths. Upload resolution requires an embedding host callback and is not configured by the stock CLI. Such a host must validate ownership, size, type, content, and destination before resolving an artifact.

BrowserIR 0.1 has no managed download tool or download artifact store. The
maintained Playwright context sets `acceptDownloads: false`, so the stock
backend does not accept page-initiated downloads. An embedding host that
changes this setting owns the download directory, ownership checks, malware
scanning, size limits, retention, and deletion. Never execute a downloaded file
merely because a page supplied it.

## Browser and process isolation

A Playwright browser context isolates cookies and storage from other BrowserIR sessions, but it is not a substitute for operating-system or container isolation. For higher-risk browsing:

- run BrowserIR as a dedicated unprivileged user;
- limit filesystem visibility and process privileges;
- use container or VM isolation appropriate to the threat;
- keep Node.js, Playwright, Chromium, and the MCP SDK patched; and
- do not disable the Chromium sandbox unless an equivalent boundary exists.

## Benchmark fixture

The dealership fixture is deliberately insecure test infrastructure. It uses published credentials, stores them in plain text, keeps sessions in process memory, and is designed around disposable synthetic data. It is not an example authentication system and must never hold production data.

Run the fixture only on an isolated development or CI host. Its built-in server
binds explicitly to `127.0.0.1`; keep that boundary intact and add stronger
host isolation where appropriate. Stop it after the benchmark. Do not expose
its reset or task-verification endpoints to untrusted clients.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use the repository host's private vulnerability-reporting feature, such as GitHub's "Report a vulnerability" flow, once the public repository is configured. The repository URL is currently an explicit release blocker. Until then, contact the maintainer through the same private channel from which you obtained the source and include:

- affected version or commit;
- impact and realistic attack scenario;
- minimal reproduction steps;
- whether the issue requires remote HTTP embedding or applies to the stock local stdio server; and
- any suggested mitigation.

Do not include real credentials, customer data, session cookies, or sensitive screenshots in the initial report. The maintainers will coordinate a private transfer method if those artifacts are necessary.
