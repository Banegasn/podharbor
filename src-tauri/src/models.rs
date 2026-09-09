use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    /// forbidden | unauthorized | not_found | auth | network | config | other
    pub kind: String,
    pub message: String,
    pub status: Option<u16>,
}

pub type CommandResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(kind: &str, message: impl ToString) -> Self {
        Self { kind: kind.to_string(), message: message.to_string(), status: None }
    }

    pub fn config(message: impl ToString) -> Self {
        Self::new("config", message)
    }

    pub fn other(message: impl ToString) -> Self {
        Self::new("other", message)
    }
}

impl From<kube::Error> for AppError {
    fn from(error: kube::Error) -> Self {
        match &error {
            kube::Error::Api(response) => {
                let kind = match response.code {
                    401 => "unauthorized",
                    403 => "forbidden",
                    404 => "not_found",
                    _ => "api",
                };
                AppError { kind: kind.to_string(), message: response.message.clone(), status: Some(response.code) }
            }
            kube::Error::Auth(inner) => AppError::new("auth", format!("Authentication failed: {inner}")),
            kube::Error::HyperError(_) | kube::Error::Service(_) => {
                AppError::new("network", format!("Cannot reach the cluster: {error}"))
            }
            kube::Error::InferConfig(inner) => AppError::config(inner.to_string()),
            _ => AppError::other(error.to_string()),
        }
    }
}

impl From<kube::config::KubeconfigError> for AppError {
    fn from(error: kube::config::KubeconfigError) -> Self {
        AppError::config(error.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeContext {
    pub name: String,
    pub cluster: String,
    pub server: Option<String>,
    pub namespace: Option<String>,
    pub user: String,
    /// exec:<command> | token | certificate | basic | none
    pub auth: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigInfo {
    pub paths: Vec<String>,
    pub contexts: Vec<KubeContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceError {
    pub namespace: String,
    pub error: AppError,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminatedState {
    pub reason: Option<String>,
    pub message: Option<String>,
    pub exit_code: i32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub name: String,
    pub image: String,
    pub image_id: Option<String>,
    pub ready: bool,
    pub started: Option<bool>,
    pub restart_count: i32,
    /// running | waiting | terminated | unknown
    pub state: String,
    pub state_reason: Option<String>,
    pub state_message: Option<String>,
    pub started_at: Option<String>,
    pub last_terminated: Option<TerminatedState>,
    pub cpu_request: Option<String>,
    pub cpu_limit: Option<String>,
    pub memory_request: Option<String>,
    pub memory_limit: Option<String>,
    pub ports: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerRef {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub kind: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSummary {
    pub uid: String,
    pub name: String,
    pub namespace: String,
    pub phase: String,
    /// kubectl-style status: Running, CrashLoopBackOff, Terminating, Completed...
    pub status: String,
    pub ready_count: usize,
    pub total_count: usize,
    pub restarts: i32,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
    pub deletion_timestamp: Option<String>,
    pub node: Option<String>,
    pub pod_ip: Option<String>,
    pub host_ip: Option<String>,
    pub qos_class: Option<String>,
    pub service_account: Option<String>,
    /// Immediate owner (ReplicaSet, StatefulSet, DaemonSet, Job...)
    pub owner: Option<OwnerRef>,
    /// Resolved workload: Deployment for ReplicaSet-owned pods, otherwise the owner itself.
    pub workload: Option<OwnerRef>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub containers: Vec<ContainerSummary>,
    pub init_containers: Vec<ContainerSummary>,
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodsResponse {
    pub context: String,
    pub pods: Vec<PodSummary>,
    pub errors: Vec<NamespaceError>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadSummary {
    pub uid: String,
    /// Deployment | StatefulSet
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub desired: i32,
    pub ready: i32,
    pub updated: i32,
    pub available: i32,
    pub images: Vec<String>,
    pub created_at: Option<String>,
    pub selector: BTreeMap<String, String>,
    pub strategy: Option<String>,
    pub paused: bool,
    pub conditions: Vec<Condition>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadsResponse {
    pub context: String,
    pub workloads: Vec<WorkloadSummary>,
    pub errors: Vec<NamespaceError>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDocument {
    pub yaml: String,
    pub json: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// RFC3339 timestamp from the kubelet, when available
    pub timestamp: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBatch {
    pub stream_id: String,
    pub lines: Vec<LogLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamEnd {
    pub stream_id: String,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamHandle {
    pub stream_id: String,
    pub namespace: String,
    pub pod: String,
    pub container: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecPluginInfo {
    pub context: String,
    pub command: String,
    /// Absolute path found on PATH (or the command itself when already absolute), None when unresolvable
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInfo {
    pub path: String,
    pub home: Option<String>,
    pub kubeconfig_env: Option<String>,
    pub shell: Option<String>,
    pub exec_plugins: Vec<ExecPluginInfo>,
}
