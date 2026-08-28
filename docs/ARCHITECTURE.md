# Legacy full-graph BrowserIR architecture

Status: archived implementation reference; not the current product contract
Last updated: 2026-08-26

> This file documents the separately retained `@browserir/core`,
> `@browserir/playwright`, and `@browserir/mcp` graph runtime. It is not the
> contract measured by the current thin-layer benchmark and is not the setup
> path from the root README. See the canonical
> [thin-layer architecture](ADAPTIVE_PLAYWRIGHT_ARCHITECTURE.md).

## Product goal

BrowserIR is a browser interaction representation and runtime for AI agents operating complex ERP, CRM, and dealership management systems.

Its primary job is not to expose the DOM. Its primary job is to preserve every distinction that can change an agent's decision or action, while removing every distinction that cannot.

The representation presented to an LLM must be **as simple as possible, but not simpler**:

- complete enough to understand and operate the current interface;
- compact enough to fit a controlled token budget;
- explicit about what is observed, inferred, unknown, or not yet loaded;
- relational, so controls retain their labels, containers, records, dialogs, and dependencies;
- actionable, so the agent knows which operations are currently possible;
- revisioned, so stale observations cannot silently drive current browser state;
- progressive, with overview, focused inspection, and small deltas instead of repeated full dumps.

This legacy design originally planned two public products:

1. a reusable browser-independent core; and
2. an MCP server that exposes the core to external AI agents.

## Architectural decisions

### Playwright is the browser backend

BrowserIR reuses Playwright for browser lifecycle and reliable mechanical interaction. Chromium is the first-class initial target.

Playwright owns:

- browser launch and connection;
- contexts, authentication state, pages, popups, and frames;
- navigation, downloads, uploads, and browser dialogs;
- keyboard, mouse, touchscreen, and drag operations;
- locator execution, actionability checks, and auto-waiting;
- screenshots and tracing.

BrowserIR owns:

- observation and sensor fusion;
- semantic entities and relationships;
- capability inference;
- identity across rerenders and virtualized content;
- evidence and confidence;
- compact model-facing views;
- revision-aware target resolution;
- typed action orchestration;
- effect verification and deltas.

BrowserIR may use raw CDP through Playwright and versioned page probes when Playwright's public high-level observations are insufficient. Playwright locators, selectors, element handles, and CDP payloads must not leak into the canonical IR or MCP schemas.

### The core is deterministic and model-independent

The core must not require an LLM. The host agent remains the primary reasoner. Optional visual or semantic enrichment may be added behind explicit provider interfaces, but deterministic rules and recorded evidence remain the foundation.

### Rich internal state, compact external views

There is no single "DOM-to-text" representation. BrowserIR maintains a rich
canonical interaction graph on the server and compiles task-appropriate views
for the model. The diagram below is the target pipeline; the current path
currently relies on Playwright lifecycle APIs and bounded page probes rather
than a complete CDP/probe sensor-fusion stack.

```text
Live browser
  -> Playwright, CDP, and page probes
  -> NormalizedObservation
  -> CanonicalInteractionGraph
  -> token-budgeted CompiledView
  -> LLM
  -> typed action
  -> resolved Playwright operation
  -> verified effect
  -> graph delta
```

### A DOM node is not an application entity

DOM identity is only source evidence. A recycled virtual-grid row can retain the same DOM node while changing from one business record to another. Conversely, a framework rerender can replace a DOM node while leaving the represented business entity unchanged.

BrowserIR therefore separates:

- **source anchors**: driver-private handles or protocol anchors; the current
  Playwright driver uses opaque element-handle IDs;
- **semantic entity IDs**: stable model-facing identities;
- **revisions**: the browser state in which an entity was observed.

Every action revalidates its target against the current revision before dispatch.

## Package boundaries

The current workspace packages are:

```text
packages/playwright-mcp/      browserir; default thin adaptive Playwright layer
packages/browser-ir/          @browserir/core; intended public core contracts and runtime
packages/playwright-driver/   @browserir/playwright; intended public Playwright driver
packages/mcp-server/          @browserir/mcp; intended public MCP adapter and stdio CLI
packages/fixture-app/         @think-dom/fixture-app; private acceptance environment
packages/benchmark/           @browserir/benchmark; private benchmark and report tooling
```

None of the public-candidate packages are published yet. The thin
`browserir` package is the default product direction; the core,
driver, and full MCP server form the separately selected full graph runtime.
The fixture and benchmark packages remain private development infrastructure.

The two source runtime directions are:

```text
default: official Playwright MCP <- thin adaptive middleware
full graph mode: MCP server -> BrowserIR core <- Playwright driver
```

Private development dependencies are separate: the benchmark package consumes
the core, Playwright driver, and fixture app; MCP qualification uses the fixture
only as test infrastructure.

The core defines a driver port. The Playwright package implements it. The MCP package calls the core API and does not control Playwright directly.

This boundary leaves room for a future WebDriver BiDi, extension, or remote-browser driver without reducing the initial Chromium implementation to a lowest-common-denominator API.

## Representation pipeline

### 1. Raw sensors

Implemented Playwright sensor coverage currently includes:

- page, popup, document, and frame lifecycle;
- exact DOM-handle snapshots and private source anchors;
- accessibility roles, names, descriptions, and states;
- computed visibility, geometry, scrolling, stacking, obstruction, and hit testing;
- values, validation, selection, expansion, busy, and disabled state;
- open Shadow DOM traversal where Playwright and page probes can access it;
- semantic scopes, choice options, labels, and native/ARIA table structure;
- evidence-backed click, double-click, drag-source, and drop-target discovery;
- viewport and entity screenshots.

The target sensor architecture additionally includes CDP-backed DOM snapshots,
versioned mutation and intersection probes, richer loading/request/activity
signals, slot and boundary modeling, and explicit opaque-region observations.
Those items are roadmap work, not claims about the current implementation.

Closed shadow roots, inaccessible cross-origin documents, canvas content, and
other opaque regions are not yet comprehensively represented. The target
invariant is that missing access remains explicit rather than appearing as an
empty interface.

### 2. Normalized observations

Driver-specific payloads are normalized before fusion. A normalized observation describes facts, source anchors, and timestamps without assigning model-facing identity.

Normalization provides:

- stable internal units and enum values;
- document and browsing-context scopes;
- a consistent evidence format;
- deterministic ordering;
- enough source provenance to debug incorrect fusion.

### 3. Canonical interaction graph

The canonical contracts can represent:

- browsers, pages, documents, and frames;
- regions, dialogs, forms, toolbars, menus, grids, tables, rows, and cells;
- semantic entities with role, name, text, value, state, and geometry;
- current action capabilities;
- relations such as `contains`, `labels`, `describes`, `controls`, `owns`,
  `popup-for`, `option-of`, `row-of`, `cell-of`, `pagination-for`, and
  `embeds-document`;
- evidence and confidence for inferred meaning and capabilities;
- transient, asynchronous, and partially loaded state;
- revisions and deltas.

The current driver populates a deliberate subset: documents and named regions;
controls, inputs, options, status messages, tables, rows, cells, and semantic
label text; plus `contains`, `labels`, `option-of`, `row-of`, `cell-of`, and
`embeds-document` relations. Dialog/form/menu container entities and
`controls`, `owns`, `popup-for`, `pagination-for`, and `describes` relations
remain available in the schema but are not yet general-purpose sensor output.
Open shadow roots are traversed and their accessible descendants are flattened
into the containing document graph. A first-class shadow-boundary or slot model
is roadmap work; the current schema does not claim one.

Core graph invariants:

1. IDs are unique within a browser session.
2. Entity references always include or imply a revision.
3. Direct observations and inferences are distinguishable.
4. Partial knowledge is explicit.
5. Repeated observation without a meaningful change preserves entity IDs.
6. Recycled source nodes do not preserve semantic identity when their record changes.
7. A delta is sufficient to move a consumer from one known revision to the next.
8. Fusion and compilation are deterministic for the same inputs.

### 4. Identity and reconciliation

The implemented reconciler first reuses an entity when the same private source
anchor still has the same driver identity key. It can then reuse one unused
prior entity with an identical identity key; otherwise it allocates a new
semantic ID. Driver identity keys combine frame/document scope with available
application keys, role or kind, name, and structural/container context. This is
deterministic equality-based reconciliation, not a general fuzzy matcher.

The target BIR-020–BIR-024 identity engine can add progressively weaker,
confidence-scored evidence—strong application keys, role/name/value and
relationships, then structure and geometry—but that broader fallback is not
implemented in the current runtime.

The current runtime requires an exact current revision and rejects stale action
references as `stale_target`; it does not attempt stale-target recovery.
Confidence- and ambiguity-bounded recovery is target behavior for BIR-024. If
added, it may proceed only when one candidate exceeds both thresholds;
otherwise the action must fail as `stale_target` or `ambiguous_target`.

The current Playwright slice gives every live frame an internal lineage
namespace and combines it with the document URL for driver identity. This keeps
identical controls in same-URL sibling frames distinct without making unrelated
documents on a later navigation look identical. The namespace remains private;
the model sees canonical child-document entities named from each iframe's
accessible label, with document-to-region-to-control containment. Duplicate
labels receive an ordinal suffix so the agent still has a usable distinction.

Observation preserves DOM order while running scope and control work with a
bounded concurrency of 16 inside each frame. Semantic scopes finish before
their controls so `contains` relationships remain correct. Playwright still
owns visibility checks, element handles, and frame-aware bounding boxes.
Semantic scopes and native controls are enumerated into exact handle snapshots,
not later re-resolved indexes, so virtualized or lazy DOM mutation cannot move
facts onto a neighboring node. Target IDs are reserved in DOM order and handle
bindings are committed only after the whole observation succeeds, so
concurrency cannot reorder duplicate identity tie-breakers or leak staged
handles after failure. In a five-sample
characterization on the 200-control fixture, this reduced the warm observation
median from 1,112.6 ms to 553.5 ms while preserving source identity and
late-control actionability. A hard cross-environment latency threshold remains
part of the BIR-091 performance-budget work.

Each page has a private frame-generation counter. Frame navigation,
attachment, or detachment invalidates an in-progress observation before target
commit. BrowserIR cleans the staged handles and retries once against the new
document; a second invalidation fails explicitly instead of returning old
entities paired with a new URL.

The driver also emits an opaque physical document-tree identity. A committed
navigation request in any frame, or a frame attachment or detachment, changes
that identity even when the URL and resulting semantic graph are identical.
The core advances the revision and invalidates prior references on that
boundary. URL fragments are excluded from driver identity, so same-document
fragment navigation can change the page view without pretending that a new
document was created. The current document-tree identity is deliberately
conservative and page-wide: replacing one child frame invalidates references
from unaffected frames too. Per-frame epochs and scoped invalidation are the
next BIR-013/BIR-056 lifecycle slice.

Server-generated client IDs are not treated as durable business identity when
a stable form `name` exists. This allows an ASP.NET WebForms postback to replace
the entire document and generate new element IDs while the logical control
retains its canonical entity ID. The new revision still makes the old
reference stale; stable semantic identity never overrides revision safety.

Opaque target identity is stored in a private per-frame `WeakMap` retained by
the driver, not in a symbol or attribute on the page's DOM nodes. Page scripts
therefore cannot preseed or merge action targets, and non-extensible elements
remain actionable. Registries are discarded on frame navigation, detachment,
page close, and session close. Semantic scope lookup receives that same private
registry as an evaluation handle, so containment does not require exposing
driver IDs to the page.

Native controls and explicit ARIA roles remain the authoritative observation
path. A bounded secondary scan covers role-less custom click targets without
promoting every DOM wrapper. It looks for active direct or inline click
listeners, React/Vue click-handler metadata, and computed pointer boundaries
that are corroborated by a delegated click ancestor. Framework metadata is
inspected only as a presence signal; BrowserIR never invokes or serializes the
handler. Aggregate delegation containers, inherited-pointer descendants,
ordinary framework-owned text, and decorative wrappers around an
already-understood native control are suppressed. A card or row with its own
strong handler evidence is retained even when it also contains a native action.

The scan returns same-snapshot element handles alongside its evidence. It never
returns DOM indexes that are re-resolved after the page can mutate. A candidate
that detaches before fact collection is skipped; evidence cannot migrate to a
replacement or neighboring node. Listener tracking always invokes the native
`addEventListener` or `removeEventListener` first and treats its own
bookkeeping as fallible advisory data, so instrumentation cannot change site
behavior. React/Vue metadata is inspected through own data-property descriptors,
so a page-defined accessor is never executed merely to build the IR. Candidate
elements and their serializable evidence are extracted in a small batch rather
than one sequential protocol round trip per candidate.

An inferred target remains a role-less `control`; BrowserIR does not invent a
button role. Its accessible label, title, or concise visible text becomes the
name, while the click capability records the inference reason and confidence.
Focusable behavior and double-click are not claimed unless independently
observed. The scan is one in-page pass over at most 25,000 elements per frame,
prioritizes stronger handler evidence, retains at most 200 inferred targets in
DOM order, then applies the existing bounded handle-processing concurrency.
When retention drops known candidates the model view reports an exact omission
count. When the raw scan itself stops at its boundary, the view reports an `at
least` lower bound because the unseen cardinality cannot be known without
violating that boundary. A delegated handler with no role, framework metadata,
pointer affordance, or other leaf-level evidence remains intentionally unmapped
rather than guessed.

The authoritative standard-control path is bounded too: per frame it scans at
most 25,000 elements and retains at most 2,000 observable elements, 200 semantic
scopes, and 2,000 option candidates. These are same-snapshot handles, not DOM
indexes re-resolved later. Known retention overflow is exact; a raw scan stop is
an `at least` analysis omission. This prevents enormous WebForms-style pages
from forcing an unbounded number of remote element handles into Node.

Choice controls have a separate, technology-neutral normalization path. Native
`select` elements, explicit ARIA comboboxes, standards-hinted custom controls
with `aria-haspopup="listbox"`, and controls inside open Shadow DOM with
document-level portal options converge on an `input` entity with role
`combobox`. The representation carries its accessible name, selected value,
expanded/enabled state, and exact capabilities. Each observed choice is an
`option` entity with its own label, value, selected/enabled state, and an
`option-of` relation to the control. An editable input combobox keeps
`fill`, `type`, and `press` alongside `select`; options that do not exist until
a debounce or lazy load are not claimed until a later observation sees them.

Selection requires one exact value or label match belonging to the target
control. Disabled options are rejected before dispatch, ambiguous matches fail
safely, and a custom control is re-resolved after it opens because framework
rendering may replace or remove the option. If the bounded option search is
incomplete, selection fails explicitly instead of assuming uniqueness.
BrowserIR does not press Enter as a
speculative fallback. If opening occurred but the exact option can no longer be
proven and clicked, the receipt is `dispatched_unverified`, not `blocked` and
not `verified`. This slice does not yet infer combobox semantics for a fully
unannotated listener-driven `div`; without portable choice evidence it remains
a generic control rather than a confident fiction.

### Implemented semantic relationships

The current deterministic relationship sensor can connect a visible label and
control even when they are in different DOM subtrees. Standards-backed
associations such as native labels and ARIA references remain authoritative.
For otherwise unassociated controls, the sensor scores bounded candidates from
same-frame scope, geometry, ordering, field type, and text evidence. It accepts
only a unique high-confidence match (currently at least `0.86` with a `0.12`
ambiguity margin), emits a `labels` relation with evidence and confidence, and
abstains on ties, cross-frame candidates, hidden labels, and weak proximity.
This is deterministic fuzzy matching; it does not call an LLM.

The implemented slice deliberately does not yet create general field-group or
subcontrol relations. Composite phone-field naming is a narrow deterministic
rule, not a general semantic-layout engine.

### Implemented table and grid structure

A bounded structural sensor normalizes native tables and explicit ARIA
`table`, `grid`, and `treegrid` structures into `table`, `row`, and `cell`
entities. It preserves header roles, row/column indices, declared row and
column counts, geometry, containment, `row-of`, and `cell-of` relations. Stable
record and column keys take precedence over ordinal fallback identity, so a
virtualized node keeps identity across value rerenders but receives a new
semantic identity when it is recycled for another business record.

Per frame, the current safety policy scans at most 25,000 elements and retains
at most 50 tables, 200 rows, and 2,000 cells, with 512 characters per structural
text field. Reaching a cap produces explicit entity, relation, or content
omissions. Higher-level table meaning—sort direction, filter ownership,
pagination controls, selected ranges, and inferred schema beyond observed
headers/counts—remains future work.

### Implemented interaction capabilities

Capabilities are attached only from semantic contracts or portable behavior
evidence. A centralized activation policy covers native or explicit ARIA
`button`, `link`, `checkbox`, `radio`, `switch`, `tab`, `treeitem`,
`menuitem`, `menuitemcheckbox`, and `menuitemradio` roles. Visible custom ARIA
options receive direct `click`; native `option` elements remain mediated by the
owning select. Name-from-content roles, including transient menu items, receive
a compact accessible name when no explicit ARIA name exists.

The interaction tracker records `click`, `dblclick`, `dragstart`, `dragover`,
and `drop` listeners without changing native registration behavior. Direct,
inline, React, and Vue evidence can add click, double-click, or drag. A tracked
ancestor double-click listener can promote a focusable structural cell with
lower confidence; ordinary sibling cells are not promoted. Native
`draggable="true"`, `aria-grabbed`, and drag-start evidence identify drag
sources. Drop evidence keeps the destination represented but does not assign it
a source-only `drag` capability.

Disabled or inert targets retain disabled capabilities for explanation;
hidden and center-occluded targets are excluded. Role-less inferred controls
remain role-less. The policy does not infer a role, an activation, or a
successful effect merely because an element has a suggestive class name.

### 5. Compiled views

The current compiler emits a deterministic interaction view. The MCP surface
also supports targeted inspection by entity reference and returns budgeted
changed-entity IDs in observation and action envelopes. Those are implemented
operations, but they are not yet independently selectable compiler modes.

The target compiler mode set is:

- `overview`: page structure, important state, and available regions;
- `interaction`: the controls and context needed for the current step; this is
  the current default view;
- `inspect`: expanded detail for selected entities or regions; current targeted
  inspection is the first implemented slice;
- `delta`: a material-change view compiled from a prior revision; current MCP
  results expose only compact changed-entity IDs.

Planned compiler inputs include mode, optional intent, focus entities, and a
prior revision. These options are not advertised at the MCP boundary until
their behavior exists. A character budget is implemented today and is exposed
as an approximate token budget by MCP.

Compiler rules:

- errors, validation messages, dialogs, menus, toasts, and new pages receive high priority;
- accessible descriptions remain in compact entity lines when they provide
  decision or recovery guidance;
- ARIA alerts and status messages are semantic `status` entities; alerts are
  transient, have no invented action capabilities, and sort ahead of ordinary
  controls;
- each control retains decision-relevant labels, state, and relationships;
- current table views expose observed structure, header roles, declared counts,
  indices, and only the rows actually observed;
- filter ownership, sort direction, pagination relations, and inferred table
  summaries are target compiler behavior, not current general-purpose output;
- unloaded or virtualized rows are never presented as observed;
- omitted detail is explicit; targeted entity inspection is implemented, and
  value-only action receipts include a bounded forward continuation index with
  fresh current-revision targets;
- DOM wrappers, styling noise, and repeated application chrome are removed;
- ordering is deterministic for stable prompts and cacheability;
- the compiled text-plus-structured view obeys its allocated character budget;
  exact transport-wrapper accounting at the minimum MCP budget remains future
  work.

The core budgets the combined canonical text and structured representation.
Evidence and confidence remain in the internal graph but are omitted from the
normal compiled view; targeted inspection can request them explicitly. When a
budget requires truncation, important transient UI, semantic scopes, form
controls, and top-of-viewport actions take priority over repetitive lower-page
links. Oversized names, descriptions, text, nested string values, capability
reasons, and explicitly requested evidence strings are locally shortened first
and contribute to an explicit `content` omission, preventing one pathological
field from evicting the entire useful view. Controls in the main work area take
priority over repeated navigation chrome. A focused inspection also retains
one-hop related entities so the container, label, or owner that disambiguates a
control does not disappear.

## Action runtime

Implemented typed actions are:

- click, double click, and context click;
- fill and type;
- select, check, and uncheck;
- focus and hover;
- press keys;
- scroll;
- drag;
- upload.

Execution follows this pipeline:

```text
expected revision + optional entity reference
  -> revision validation
  -> target and capability validation when the action is targeted
  -> capability and actionability checks
  -> Playwright dispatch
  -> bounded causal settling
  -> incremental observation
  -> effect verification
  -> ActionReceipt and graph delta
```

An action receipt distinguishes:

- `verified`;
- `dispatched_unverified`;
- `no_effect`;
- `stale_target`;
- `ambiguous_target`;
- `blocked`.

Dispatch is not success. A mutating action with an uncertain dispatch result must not be retried automatically.

Verified `fill`, `type`, `select`, `check`, and `uncheck` actions use a
delta-first receipt only when no page, entity, relationship, or structural
meaning changed. The core keeps a bounded transition proof and allows an older
entity identity to be rebound only across a complete unbroken sequence in
which that identity remained semantically stable. Missing history, sensor
omissions, document replacement, recycled rows, removals, or structural
changes fail `stale_target`.

To keep delta receipts useful to smaller models, the MCP layer adds an
`actionable_context` of at most 640 serialized characters. It starts after the
acted control in visual order, carries one shared page/revision plus fresh
compact target identities, excludes hidden, disabled, and link targets, and
reports an exact omitted count. Raw text-field values are not repeated. A
structural action still returns the full compiled view.

Effect verification uses observed target/page changes and navigation or popup
events appropriate to the action. The fixture app's database and audit log
remain the end-to-end acceptance oracle, not part of the production runtime.

A new document is evidence that an action caused a lifecycle change, but it is
not proof that the requested mutation succeeded. `fill`, `type`, `check`, and
`uncheck` still require the requested target value or state in the resulting
representation. `select` verifies the exact requested set from the control plus
its related `option` entities, including multi-select controls. A rejected
full-page postback therefore remains `dispatched_unverified` even though the
document, revision, and generated client IDs all changed.

## Screenshots

Screenshots supplement the IR; they do not replace it. They are useful for canvas, charts, visual grouping, icon-only meaning, occlusion, and visual confirmation.

The default stable browser profile is:

- viewport: 1440 x 900 CSS pixels;
- device scale factor: 1;
- zoom: 100%;
- light color scheme;
- reduced motion.

The Playwright dependency selects the Chromium revision. Locale and timezone
can be fixed at browser creation; font availability and environmental pinning
remain deployment or benchmark-runner responsibilities rather than guarantees
of the core API.

The profile is configurable at browser creation and remains fixed for that
session. No public runtime viewport-mutation operation is implemented today; a
future viewport change must invalidate the current representation revision.

Every capture is bound to:

- browser, page, and revision (the current document is implicit in that
  revision);
- viewport dimensions and device scale factor;
- scroll offset and clip;
- optional target entity;
- capture timestamp.

The runtime checks the requested revision before capture and observes again
afterward. It returns the pixels only when the represented revision is still
unchanged; a changed or unverifiable page produces a retryable error. This is a
representation-stability guard, not an atomic browser primitive, so a purely
visual change outside the graph can still race with the screenshot.

Viewport and entity PNGs are the implemented capture kinds. One capture is
bounded to 8,294,400 physical pixels and 16 MiB of encoded data. Full-page
capture is future work and, if added, should remain outside the normal agent
loop.

## MCP server

The MCP server targets the 2026-07-28 MCP specification and keeps protocol concerns out of the core.

Implemented stock tool surface:

| Tool | Responsibility |
| --- | --- |
| `browser_create` | Create an isolated browser context and return opaque handles |
| `browser_navigate` | Navigate and return the resulting compact observation |
| `browser_observe` | Return the current compact view and changes from the preceding observation |
| `browser_inspect` | Expand entities, regions, relations, or evidence |
| `browser_act` | Execute one typed action |
| `browser_wait` | Wait for a bounded semantic condition |
| `browser_pages` | List current pages and popups |
| `browser_capture` | Capture a viewport or entity image and reject represented changes during capture |
| `browser_close` | Close a page or browser session |

The default catalog is exactly those nine tools. An experimental tenth tool,
`browser_evaluate_unsafe`, is implemented but completely absent unless every
required opt-in layer is present. The stock CLI wires those layers only for the
explicit `--enable-unsafe-evaluate` startup flag. An embedding host must provide
the runtime service's `unsafeEvaluate` configuration with a required redacted
audit callback and separately set the MCP server's enable flag; the server
refuses an enabled registration when the service implementation is absent.

The public model-facing `browser_act` contract is flat. The action `kind` and
its fields share the top level with `browser_id`, optional `page_id`, and
`expected_revision`; for example:

```json
{
  "browser_id": "browser-1",
  "page_id": "page-1",
  "expected_revision": 7,
  "kind": "fill",
  "target_ref": "e15@r7",
  "value": "Ada"
}
```

Model views display refs as `[e15@r7]`, while tool calls copy the token without
brackets. Most entity actions use `target_ref`; drag uses `source_ref` and
`destination_ref`, plus optional `destination_page_id`. Page-scoped press and
scroll may omit a target. The MCP boundary rejects nested or stringified
actions, malformed refs, and fields unrelated to the selected kind, then
translates a valid call into the core's typed action representation.

`browser_wait` follows the same flat rule. Its kinds are `revision_change`,
`text` with `value`, `entity_state` with `target_ref` and `state`, and
`settled`. Nested or stringified conditions are rejected before dispatch.

`browser_navigate`, `browser_inspect`, `browser_act`, `browser_wait`, and
`browser_capture` require `expected_revision`; `browser_observe` and
`browser_close` can optionally assert one. Results include applicable pre- and
post-action revisions. `browser_navigate`, `browser_observe`,
`browser_inspect`, `browser_act`, and `browser_wait` accept `max_tokens`; the
default is 4,000 approximate tokens and the public minimum is 256. The budget
covers the complete model result. BrowserIR reserves capacity for the compact
delta and protocol metadata instead of allowing the page view to consume the
entire allowance.

An explicit top-level `page_id` selects the action or wait page. If it is
absent, BrowserIR infers a page only when exactly one page is open; multiple
pages fail `ambiguous_page`, and zero pages fail `unknown_page`. A drag may
separately select its destination with `destination_page_id`.

The `settled` wait is stateful: it returns only after two consecutive
observations have no graph delta and no represented entity is busy. Any graph
change or busy entity resets the consecutive count. This gives agents a bounded
semantic alternative to arbitrary sleeps without treating one quiet sample as
proof that a staged enterprise UI has finished.

The MCP response has one canonical model-facing representation:

- text content contains the budgeted page view and revision-bound entity refs;
- structured content contains browser/page handles, revision, truncation,
  omissions, and compact changed entity IDs;
- verified value-only action results contain a compact delta plus bounded
  `actionable_context`; structural results return the compiled view, and no
  result repeats full entities inside a nested observation;
- large deltas are truncated independently and report a `changes` omission;
- post-action revisions are normalized to the observed current revision;
- raw driver action-error messages are replaced with stable model-safe errors;
- `browser_inspect` is the deliberate exception that returns targeted
  structured entities and can include evidence when explicitly requested.

The first semantic-context slice emits named navigation, main, and toolbar
regions plus `contains` relations. Relation endpoints use driver-private source
IDs during reconciliation, then canonical IDs in model views, so duplicate
controls do not collapse and source handles never leak. Reconciliation prefers
an exact surviving source before semantic fallback, preventing duplicate
siblings from stealing each other's canonical IDs. Mutable document-title
fallbacks are display names only and do not participate in scope identity.
Server-rendered validation summaries and `aria-describedby` field errors now
survive that pipeline, so an agent can observe rejection, correct the named
fields, and retry without reading raw DOM. Focused native constraint failures
also contribute `invalid` state and the browser's validation message.
Multi-input phone widgets use a narrow composite-field inference: the required
phone input receives the concise field caption, the label-controlled companion
is identified as the country-code control, and mounted listbox options are
excluded from that inferred caption.

Perceptibility is not equated with mounted DOM. Standard and inferred controls
must pass style, geometry, viewport, and center hit-test checks. Covered selector
contents are omitted until revealed, and page-visible text is assembled from
perceptible text ranges rather than raw `body.innerText`.

Browser handles are opaque, scoped to the runtime service, and validated on
every call. The stdio connection owns cleanup of its browser sessions and
allows at most four owned or in-flight browsers. The maintained driver retains
at most 32 pages per browser and analyzes at most 64 documents per observation;
excess popups are closed and skipped documents are declared as analysis
omissions. Idle and absolute expiry, tenant-aware ownership, aggregate memory
quotas, and artifact quotas are not implemented yet.
The MCP transport's session state is not used as the source of truth for
browser state.

### Unsafe page evaluation

Arbitrary page code is an escape hatch, not the normal interaction model.
BrowserIR should strive to make arbitrary code unnecessary. The reference
workflows, qualification runner, and benchmark use the default nine tools and
never enable evaluation.

When explicitly enabled, `browser_evaluate_unsafe` requires a selected
`page_id`, the current page revision, and a non-empty expression. The maintained
driver executes it in Chromium's main/default page world through the DevTools
Protocol, never in the MCP server's Node.js context. This page-context boundary
protects the host process API from direct access; it does not stop the code from
reading or exfiltrating page/session data, making authenticated requests,
mutating browser storage or service workers, navigating, or opening popups.
The DevTools path permits the supplied expression even when the page's script
Content Security Policy would block an in-page `eval`; CSP is not a containment
boundary for this explicitly enabled tool.

The public bounds are deliberately small:

- expression: 16,384 characters and 32 KiB UTF-8;
- timeout: 2 seconds by default and at most 5 seconds;
- returned JSON: 8 KiB by default and at most 64 KiB, with the effective limit
  reduced further by the complete model-result budget; and
- bounded JSON traversal and serialization rather than unconstrained
  `JSON.stringify` over a page object.

Timeout, cancellation, and an unacknowledged evaluation-command failure trigger
hard CDP execution termination. If termination cannot be confirmed, the driver
requests page closure and verifies that the target closed. If that also cannot
be confirmed, it irreversibly invalidates the logical browser session and
attempts bounded best-effort context/browser shutdown. Evaluation is never retried.
Only bounded JSON-compatible values are returned; unsupported, cyclic,
over-deep, or oversized values produce a stable failure with the result omitted.

Before dispatch, the runtime observes and checks the expected revision. After a
dispatched call whose browser remains usable, it performs a full observation and
forces a revision advance, invalidating every prior entity reference on the page
even when the represented graph appears unchanged. A post-observation failure
invalidates the complete browser. If page-level execution containment fails, the
logical browser is invalidated immediately and post-observation is deliberately
skipped because that browser is no longer trusted or usable.
New popup page IDs are reported as metadata; their content enters the IR only
through normal page observation.

Audit is a fail-closed part of enablement, not optional logging. The required
callback receives an intent record before dispatch and a completion record
afterward. Intent-audit failure blocks execution; completion-audit failure after
dispatch invalidates the browser. Records contain a SHA-256 expression digest,
expression byte length, target handles, revisions, requested/effective limits,
duration, outcome, termination state, and verification state. The expression
and returned value are never placed in an audit record.

Model-facing return values receive heuristic redaction for familiar secret
keys, token forms, and sensitive URL components. That is data minimization, not
DLP: arbitrary code can intentionally encode or transmit information, and
unknown business secrets can still be returned.

## Security and lifecycle

Implemented safeguards include opaque browser/page handles, private
driver targets, revision checks, deterministic session cleanup, sensitive-input
value redaction, sensitive URL-component redaction, capture and session bounds,
automatic-download rejection, HTTP/HTTPS-only navigation schemas, model-safe
action errors, local stdio delivery, and unsafe evaluation absent from the
default tool catalog. Explicitly enabled unsafe evaluation adds bounded
execution, bounded JSON serialization, hard cancellation, forced observation
and reference invalidation, and fail-closed audit requirements; these controls
do not make arbitrary page code safe.

Production-hardening targets that remain future work include:

- idle and absolute time-to-live limits;
- tenant-aware ownership checks;
- aggregate memory and artifact quotas beyond the implemented browser/page/capture bounds;
- complete cancellation propagation;
- deployer-configurable navigation, egress, and network policies;
- private artifact caching and retention policy;
- complete observation, action, effect, and confirmation audit records;
- revision-bound confirmation for consequential ERP operations;
- general redaction hooks before model-facing compilation and trace persistence.

Known sensitive input values and URL components are minimized before they enter
an IR view. Screenshots and unrecognized page content remain sensitive. Unsafe
evaluation has separate result-redaction and audit boundaries, but the host
still owns authorization, egress isolation, and any stronger DLP requirement.

## Test-driven development policy

All behavior is developed red-green-refactor:

1. write the smallest failing test that states the required externally visible behavior;
2. run it and verify it fails for the intended reason;
3. implement the minimum behavior needed to pass;
4. run the focused test, then the affected package suite;
5. refactor only while tests remain green;
6. run workspace type checking and the relevant acceptance suite before moving the card to Done.

Bug fixes begin with a reproducing regression test. Tests must assert public contracts and observable behavior, not private implementation details.

The test layers are:

- contract and schema tests;
- pure unit tests for fusion, reconciliation, deltas, and view compilation;
- public-view conformance tests against independent business contracts, with
  coverage, semantic, relationship, actionable-precision, text-parity, and
  representation-density checks;
- driver tests against focused HTML fixtures;
- MCP protocol and tool-contract integration tests;
- browser workflows against the fixture app;
- database and audit-log acceptance verification;
- performance and payload regression tests.

The core must be testable with a deterministic fake driver. Time, generated IDs, and browser events must be injectable or controllable in tests.

## Implementation milestones and acceptance gates

The milestones below are retained as historical design gates, not as current
thin-layer release status and not as a claim that every item is implemented.

### M0: Contracts and scaffolding

- Core, Playwright driver, and MCP packages type-check.
- The core runs against a fake driver.
- No Playwright or MCP type leaks into canonical contracts.
- Tests fail before and pass after each initial contract implementation.

### M1: End-to-end vertical slice

- Create, navigate, observe, inspect, fill, click, capture, and close work through MCP.
- Login and create-customer workflows use only BrowserIR entity references.
- No CSS, XPath, direct DOM query, or arbitrary evaluation is used by the reference client.
- The database and audit log verify the intended customer mutation.
- The final action reports a verified effect.

### M2: Sensors and canonical graph

- DOM, accessibility, layout, lifecycle, and probe evidence is fused deterministically.
- Repeated unchanged observations preserve IDs and produce an empty delta.
- Nested documents and inaccessible regions remain explicit.
- Each inference records evidence and confidence.

### M3: Identity and delta engine

- Framework rerenders preserve semantic identity when meaning is unchanged.
- Virtualized row recycling replaces semantic record identity.
- Stale references recover only when resolution is uniquely high-confidence.
- Ambiguous targets fail safely.

### M4: View compiler

- Required current controls are represented or explicitly reachable through inspection.
- Compiled output obeys token budgets and reports omissions.
- Unobserved virtualized data is never claimed as present.
- The same graph and options produce byte-identical output.

### M5: Action runtime

- Typed actions complete all fixture workflows without selectors or arbitrary code.
- Every result distinguishes dispatch from verified effect.
- Uncertain mutating actions are not automatically retried.
- All 14 database and audit-log task verifiers pass.

### M6: Difficult UI coverage

- Current positive cases cover validation, pagination, virtualization, debounce, portals,
  wizards, bulk actions, transient menus, inline editing, drag, polling, popups,
  and dynamic rows.
- Focused positive and abstention fixtures cover open Shadow DOM, nested frames,
  unnamed clickables, custom dropdowns, hover/tooltips, contenteditable,
  uploads, native dialogs, and occlusion. Closed shadow roots and canvas/WebGL
  controls remain unsupported rather than implied by fixture presence.
- Supported positive cases have representation and action/effect assertions;
  unsupported cases assert conservative omission or abstention where observable.

### M7: Visual evidence

- Viewport and entity captures carry complete revision metadata.
- A post-capture observation rejects pixels when represented state changed;
  purely visual races outside the graph remain an explicit 0.1 limitation.
- The stable viewport profile is covered by regression tests.

### M8: Future remote transport and production hardening

- Add TTLs, tenant ownership, complete cancellation, deployer policy, and auditing.
- Add revision-bound confirmation for consequential actions.
- Add Streamable HTTP only with a separately defined remote security boundary.
- Run an applicable official conformance suite when one is selected and pinned.

These are roadmap gates for a future remotely deployable product, not claims or
release requirements for the local-stdio-only legacy 0.1 runtime.

### M9: Unsafe evaluation

- The default tool list does not contain `browser_evaluate_unsafe`.
- Explicitly enabled evaluation is page-context only, bounded, audited, and followed by full observation.
- Typed actions remain sufficient for all fixture acceptance workflows.

## Release criteria

BrowserIR v0 is releasable when:

- all 14 reference workflows pass through compiled views and entity references;
- no required workflow uses selectors, XPath, or arbitrary evaluation;
- stale and ambiguous references fail safely;
- virtualized record identity is correct;
- no mutation is reported successful without observed evidence;
- views obey their budgets and declare omissions;
- screenshots pass the documented represented-state stability guard;
- unsafe evaluation is absent by default;
- the stock stdio transport passes official-client protocol, tool-surface, EOF,
  signal-cleanup, and stale-reference tests;
- full observation, delta, compilation, target resolution, action, and total-step
  p50/p95 metrics are recorded and regression-tested.
