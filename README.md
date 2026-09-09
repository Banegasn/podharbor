# PodHarbor

A developer-focused desktop workspace for Kubernetes pods, workloads, and logs. Angular 22 UI in a Tauri 2 window, Rust
backend on [kube-rs](https://kube.rs). Sibling of [S3 Studio](https://github.com/Banegasn/s3-studio): same idea, same look — reuse the
credentials you already have instead of setting anything up.

[Website](https://banegasn.github.io/podharbor/) · [Download](https://github.com/Banegasn/podharbor/releases/latest) · [Releases and publishing](docs/RELEASING.md)

## Zero setup

The app reads the kubeconfig `kubectl` already uses (`$KUBECONFIG`, or `~/.kube/config`) and honours its
exec authentication plugins (`aws eks get-token`, `gke-gcloud-auth-plugin`, …), including token refresh.
Every kubeconfig context is an **environment** in the header. Because apps launched from Finder or the Dock
get a minimal `PATH`, the app borrows the login shell `PATH` once at startup so the exec plugin binary is found.

Nothing is written to the cluster unless you explicitly confirm a **Delete pod** or **Rollout restart**
dialog. The only local state is UI preferences in the webview `localStorage`.

## Features

- **Environments** — every kubeconfig context; production-looking names are flagged red.
- **Namespaces** — multi-select. When your role cannot list namespaces at cluster scope (common with
  restricted EKS roles) you can add namespaces by hand; they are validated and remembered per context.
- **Pods** — filterable, sortable table with kubectl-style status (`CrashLoopBackOff`, `Terminating`,
  `Init:1/2`…), ready count, restarts, age, node, image tag; details drawer with per-container image /
  image ID / state / last termination / requests & limits / ports, labels, conditions, YAML and JSON.
- **Workloads** — Deployments and StatefulSets with desired / ready / updated / available replicas,
  images, conditions and the pods behind them.
- **Logs** — tail several pods at once, across namespaces, merged by kubelet timestamp with a colour per
  pod; follow, filter (plain or `/regex/`), ERROR/WARN highlight, tail size and "since", per-source stop.
- Auto-refresh polling (pausable), light / dark theme, keyboard shortcuts, diagnostics panel showing the
  `PATH` / `KUBECONFIG` the app resolved.

Not included on purpose: metrics (`kubectl top`) and events — the target roles cannot read them — and
shell/exec into pods.

## Development

```sh
pnpm install
pnpm dev            # Angular only, http://localhost:4200 — runs on demo data outside Tauri
pnpm desktop:dev    # Tauri window with HMR against your real kubeconfig
pnpm desktop:build  # native bundle in src-tauri/target/release/bundle
```

Live smoke tests of the Rust backend against your kubeconfig (needs cluster access):

```sh
PODHARBOR_CONTEXT=pre PODHARBOR_NAMESPACE=pre cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture
```

Architecture, the Tauri command contract and the design tokens live in `docs/ARCHITECTURE.md`.

## RBAC needed

Read: `pods`, `pods/log`, `deployments.apps`, `statefulsets.apps` (`get`, `list`) in the namespaces you use;
`namespaces` `list` is optional. Write, only if you use the actions: `pods` `delete`,
`deployments.apps` / `statefulsets.apps` `patch`.

## Releases

`./release.sh <version>` bumps `package.json`, `src-tauri/tauri.conf.json` and `Cargo.toml`, tags `v<version>`
and pushes; GitHub Actions (`.github/workflows/release.yml`) builds macOS (Intel + Apple Silicon), Windows and
Linux bundles and attaches them to the release.
