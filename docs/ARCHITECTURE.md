# PodHarbor — architecture and frontend contract

Lightweight Lens-like desktop console. **Tauri 2 + Rust backend** (`src-tauri/`) talks to Kubernetes with
`kube-rs`, reading the same kubeconfig `kubectl` uses (`$KUBECONFIG` or `~/.kube/config`, exec auth plugins
such as `aws eks get-token` included). **Angular 22 frontend** (`src/`) renders it. Zero setup: nothing is
stored server-side; the only local state is UI preferences in `localStorage`.

Sibling project and visual reference: [S3 Studio](https://github.com/Banegasn/s3-studio) (React + Tauri). Reuse its design
language — the design tokens below are ported from `s3-studio/src/styles/tokens.css`.

## Runtime facts that shape the UI

- Kubeconfig contexts are the "environments" (here: `pre`, `pro`; each has a default namespace).
- **Namespace listing may be forbidden** (`AppError.kind === 'forbidden'`) even when pods in a namespace
  can be listed. The UI must then fall back to: the context default namespace + namespaces the user adds
  by hand (validated with `probe_namespace`), persisted per context in `localStorage`.
- Pods `list/watch/delete` and `pods/log` are allowed. Deployments and StatefulSets `list` allowed;
  `patch` (restart) is allowed only on some contexts → surface the backend error inline, do not pre-check.
- Events and metrics are **not** available for this role: no CPU/mem columns, no events tab.
- Typical namespace size: 200–260 pods. Lists are fetched on demand and by polling (default 10s,
  configurable, pausable); no cluster watch.

## Tauri commands (all `invoke` from `@tauri-apps/api/core`)

Argument names are camelCase on the JS side (Tauri converts to the Rust snake_case). Errors are rejected
promises carrying an `AppError` object.

```ts
type AppError = { kind: 'forbidden'|'unauthorized'|'not_found'|'auth'|'network'|'config'|'api'|'other'; message: string; status?: number };

environment_info(): EnvironmentInfo            // paths, shell + exec plugin resolution — for a diagnostics panel
list_contexts(): KubeconfigInfo                 // re-reads kubeconfig and clears the client cache
list_namespaces({ context }): string[]          // may reject with kind 'forbidden'
probe_namespace({ context, namespace }): number // pod count; rejects if not readable
list_pods({ context, namespaces: string[] }): PodsResponse
get_pod_document({ context, namespace, name }): ResourceDocument      // { yaml, json }
delete_pod({ context, namespace, name }): string                      // "restart" a pod; confirm first
list_workloads({ context, namespaces: string[] }): WorkloadsResponse  // Deployments + StatefulSets
get_workload_document({ context, namespace, kind, name }): ResourceDocument
restart_workload({ context, namespace, kind, name }): string          // kubectl rollout restart; confirm first
start_log_stream({ context, namespace, pod, container?, tailLines?, sinceSeconds?, follow?, previous? }): LogStreamHandle
stop_log_stream({ streamId }): void
stop_all_log_streams(): number
open_devtools(): void
```

### Events (`listen` from `@tauri-apps/api/event`)

- `log-batch` → `{ streamId, lines: { timestamp?: string; text: string }[] }` (batched every ≤120 ms / 500 lines)
- `log-end`   → `{ streamId, error?: AppError }`

### Types (mirror of `src-tauri/src/models.rs`, camelCase)

```ts
type ExecPluginInfo = { context: string; command: string; resolved: string | null /* absolute path on the app PATH, null when missing */ };
type EnvironmentInfo = { path: string; home?; kubeconfigEnv?; shell?; execPlugins: ExecPluginInfo[] };
type KubeContext = { name; cluster; server?; namespace?; user; auth: string /* exec:aws | token | certificate | ... */; isCurrent: boolean };
type KubeconfigInfo = { paths: string[]; contexts: KubeContext[] };
type NamespaceError = { namespace: string; error: AppError };
type TerminatedState = { reason?; message?; exitCode: number; startedAt?; finishedAt? };
type ContainerSummary = { name; image; imageId?; ready: boolean; started?: boolean; restartCount: number;
  state: 'running'|'waiting'|'terminated'|'unknown'; stateReason?; stateMessage?; startedAt?;
  lastTerminated?: TerminatedState; cpuRequest?; cpuLimit?; memoryRequest?; memoryLimit?; ports: string[] };
type OwnerRef = { kind: string; name: string };
type Condition = { kind; status; reason?; message?; lastTransition? };
type PodSummary = { uid; name; namespace; phase; status /* kubectl-style */; readyCount; totalCount; restarts;
  createdAt?; startedAt?; deletionTimestamp?; node?; podIp?; hostIp?; qosClass?; serviceAccount?;
  owner?: OwnerRef; workload?: OwnerRef /* Deployment resolved from ReplicaSet */;
  labels: Record<string,string>; annotations: Record<string,string>;
  containers: ContainerSummary[]; initContainers: ContainerSummary[]; conditions: Condition[] };
type PodsResponse = { context; pods: PodSummary[]; errors: NamespaceError[]; fetchedAt: string };
type WorkloadSummary = { uid; kind: 'Deployment'|'StatefulSet'; name; namespace; desired; ready; updated; available;
  images: string[]; createdAt?; selector: Record<string,string>; strategy?; paused: boolean;
  conditions: Condition[]; labels: Record<string,string> };
type WorkloadsResponse = { context; workloads: WorkloadSummary[]; errors: NamespaceError[]; fetchedAt: string };
type ResourceDocument = { yaml: string; json: string };
type LogStreamHandle = { streamId; namespace; pod; container };
```

## Frontend structure (Angular 22, standalone, signals, zoneless)

```
src/app/
  core/
    tauri.service.ts        typed wrappers for every command + event listeners
    kube-state.service.ts   selected context, namespaces (discovered | manual), polling, pods, workloads
    logs.service.ts         multi-stream aggregation: N streams → one ordered buffer (by timestamp), pause/follow, cap 20k lines
    prefs.service.ts        localStorage: theme, per-context namespaces, poll interval, tail size, log levels, wrap, drawer width, per-table column widths
    format.ts               age (7d4h / 38h / 12m), image → { registry, repo, tag, digest }, quantity helpers
  shell/
    app-header              context picker (environment), namespace chips + "add namespace", refresh/poll toggle, theme toggle, view tabs
    status-bar              fetchedAt, pod/workload counts, per-namespace errors, active log stream count
  pods/
    pods-table              filterable/sortable/resizable table: name, namespace, workload, ready, status (colored), restarts, age, node, image tag
    pod-details             right drawer for one pod: overview (facts + inline tail), containers (image / imageId / state / last termination / resources / ports), labels, conditions, YAML/JSON viewer, actions (logs, delete pod)
    pods-selection          right drawer for 2+ selected pods: selection summary + merged tail of their logs
  workloads/
    workloads-table         kind, name, namespace, replicas desired/ready/updated/available, image tags, age, conditions; expand → its pods
  logs/
    logs-view               bottom pane or full tab: source chips (pod/container), text filter, level chips, timestamps toggle, follow, wrap, clear, tail size, "since", download as .txt via Blob
    log-stream              virtualised renderer of one LogsService buffer (fixed pitch; capped tail when wrapping)
    log-level-filter        ERROR · WARN · INFO · DEBUG · other chips with counts, shared by both panes
  shared/
    ui primitives           button, badge, dialog (confirm), toast stack, empty/error states
    icon-btn                one rule for every icon-only button: square box (--control-height / -sm / --icon-btn-sm), icon centred, no padding
    drawer-resize           drag/keyboard/persist logic for a right drawer + its handle component
    column-sizing           per-table column widths (grid-template-columns) + its header handle component
```

### Behaviour

- **Environment**: header select with every kubeconfig context; `pro`-like names (`pro`, `prod`, `production`)
  get a red badge. Switching context stops all log streams, reloads namespaces and lists.
- **Namespaces**: two independent sets per context, both persisted. The **known** list is what the user
  keeps (everything `list_namespaces` discovered, plus every manual addition); the **enabled** set is the
  subset used as the list filter. Header chips toggle enabled/disabled only — dashed and muted when off —
  and never remove anything. The gear opens *Manage namespaces*: enable toggles, Enable all / Disable all,
  an explicit Remove per manual namespace (discovered ones are tagged and unremovable), and the add input.
  Adding probes with `probe_namespace`, retried once after 800 ms unless the error kind is `forbidden`;
  0 pods is a success, and a final failure shows kind + status + verbatim message with an "Add anyway"
  action that keeps the namespace unvalidated (its read error then surfaces in the status bar).
- **Pods**: table with instant text filter (name, workload, image, node, status), sort on any column,
  status colour (Running+all ready green, Pending/ContainerCreating amber, CrashLoopBackOff/Error/ImagePull* red,
  Terminating grey, Completed muted). Restarts > 0 highlighted. Row click → details drawer (and replaces the
  selection, as a table click does). Multi-select checkboxes → "Tail logs" for the selection (across
  namespaces) and the selection drawer. Group-by-workload toggle.
- **Details drawer**: one drawer, two contents. A single pod (clicked, or the only one checked) shows
  Overview / Details; 2+ checked pods show the **selection summary** — count, namespaces, workloads,
  status breakdown, total restarts, distinct `repo:tag` images, oldest/newest age — over a merged tail of
  the selection (first 8 pods; wider selections say so), with the same level / wrap / filter controls,
  "Open in Logs tab" and "Clear selection". Dropping back to one pod returns to the single view.
  Both are dragged from the handle on their left edge: min 380px, max 80vw, `body.is-resizing` while
  dragging, double-click resets, width persisted (`drawerWidth`) and shared by both.
- **Resizable columns**: every header cell of the Pods and Workloads tables carries a handle on its right
  edge (drag, ←/→ keys, double-click to reset). Widths are persisted per table (`columnWidths`) and drive
  one `grid-template-columns` for the header and every row. Defaults are never narrower than what the
  header label plus its sort icon measures (canvas text metrics), so no column starts out clipped; the
  name column takes the leftover width until it is dragged.
- **Workloads**: replicas as `ready/desired` with a colour when not fully available; image tag per
  container; `rollout restart` behind a confirm dialog naming the context; expand row → matching pods (selector labels).
- **Logs**: one aggregated stream over the selected (pod, container) sources; lines prefixed with a
  colour-coded pod badge (stable colour per pod) and the namespace when >1 namespace is present; ordered by
  kubelet timestamp; follow-to-bottom that auto-pauses when the user scrolls up; text filter (plain +
  `/regex/`); highlight ERROR/WARN/Exception; per-source stop; restart streams when a pod disappears
  (show a "pod gone" marker). Cap buffer at 20 000 lines (drop oldest).
- **Log levels**: detected once per line on the way into the buffer (JSON `"level"`, `level=warn`,
  Java/Spring caps, lower case near the head of the line, `Exception`/`Traceback`/`panic:`), with
  stack-trace continuation lines inheriting the level of the line they belong to. The chips (ERROR · WARN ·
  INFO · DEBUG · other) filter on top of the text filter and their counts follow it, never the chips;
  stream markers are exempt. The enabled set lives in prefs, so both log panes share it and it survives a
  reload. **Wrap** is a shared preference too, default off: off means one line per entry and the pane —
  never the page — scrolls horizontally; on means a hanging indent under the timestamp and pod badge, and
  the virtualiser renders a capped tail instead of a fixed-pitch window.
- **Details drawer** YAML viewer: plain `<pre>` with light syntax colouring; no Monaco (keep bundle small).
- **Selects** are `appearance: none` with a themed chevron background and symmetric padding
  (`0 28px 0 10px`): WebKit's own inset padding and arrow differ from Blink's, and its vertical centring
  ignores `line-height`, so the box height alone centres the text.
- **Theme**: light/dark tokens below, toggle in header, follows OS by default. Tauri window uses
  `titleBarStyle: Overlay` on macOS → the header must reserve ~78px on the left for traffic lights and
  be a drag region (`data-tauri-drag-region`).
- **Errors**: `AppError.kind` drives copy: `auth` → "credentials expired / run `aws sso login`" hint;
  `forbidden` → "your role cannot …"; `network` → "cluster unreachable (VPN?)".
- **Keyboard**: `Cmd/Ctrl+K` focus filter, `Cmd/Ctrl+R` refresh, `Esc` closes drawer/dialog, `Cmd/Ctrl+L` clear logs.

### Conventions

- Angular: standalone components, `input()`/`output()`/`signal`/`computed`, `inject()`, `@if/@for`,
  `ChangeDetectionStrategy.OnPush`, zoneless. Signals prefixed `$` (`$pods`), private `#$x`.
- No Angular Material, no CDK, no Tailwind. `lucide-angular` for icons. SCSS with the CSS variables below.
- Keep bundle lean; no global state library.

## Design tokens (port to `src/styles/_tokens.scss`, applied on `:root` and `[data-theme='dark']`)

Light: bg #f3f5ef · bg-light #f9fbf5 · surface #ffffff · subtle #f7f9f4 · hover #e8eee2 · active #e4f0de ·
fg #242822 · fg-muted #6a7165 · border #d8ddd2 · border-light #dfe5d8 · accent #2f5f8f · accent-light #3d73a8 ·
accent-bg #e6edf4 · warm #c98219 · row-border #edf0e8 · table-head #eef2e9 ·
success bg #e1f2e5 / border #bad8c1 / fg #28633a · error bg #f8e6df / border #e5bba9 / fg #76341f ·
info bg #e6eef7 / border #c4d6e8 / fg #315d88 · warning bg #fff9dc / border #d7c586 / fg #865917.

Dark: bg #071018 · bg-light #0b151e · surface #101c25 · subtle #0e1a23 · hover #162633 · active #1b2d2b ·
fg #e8f0ea · fg-muted #9aa9a2 · border #26333d · border-light #2c3a43 · accent #22d3ee · accent-light #67e8f9 ·
accent-bg #102e38 · warm #f59e0b · row-border #1e2b34 · table-head #111f28 ·
success bg #0f2d22 / border #245f48 / fg #87e6b0 · error bg #321b18 / border #79372e / fg #ffb4a8 ·
info bg #102a3f / border #285b80 / fg #93d5ff · warning bg #35270c / border #7f5d19 / fg #ffd47a.

Typography: Inter/system-ui, base 14px, mono `ui-monospace, SFMono-Regular, Menlo, Consolas`. Radius 6/8px.
Sizing scale (one source for the app's density): rows 34px, table heads 30px, controls 32px / 28px dense,
chips and dense icon buttons 26px, log line pitch 20px (restated as `ROW_HEIGHT` in `log-stream`).

## Scripts

- `pnpm dev` — Angular dev server on :4200 (what Tauri's `beforeDevCommand` runs)
- `pnpm desktop:dev` — Tauri window + HMR
- `pnpm build` → `dist/podharbor/browser` (Tauri `frontendDist`)
- `pnpm desktop:build` — native bundle (`src-tauri/target/release/bundle`)
- `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture` — live smoke tests against the kubeconfig
