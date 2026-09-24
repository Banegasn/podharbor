use crate::kube_client::ClientCache;
use crate::models::*;
use k8s_openapi::api::core::v1::{Container, ContainerStatus, Pod};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use kube::api::{DeleteParams, ListParams};
use kube::Api;
use std::collections::BTreeMap;

pub fn time_string(value: Option<&Time>) -> Option<String> {
    value.map(|t| t.0.to_string())
}

pub fn now_string() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn container_summary(spec: &Container, status: Option<&ContainerStatus>) -> ContainerSummary {
    let (state, reason, message, started_at) = match status.and_then(|s| s.state.as_ref()) {
        Some(state) if state.running.is_some() => {
            ("running", None, None, time_string(state.running.as_ref().and_then(|r| r.started_at.as_ref())))
        }
        Some(state) if state.waiting.is_some() => {
            let waiting = state.waiting.as_ref().unwrap();
            ("waiting", waiting.reason.clone(), waiting.message.clone(), None)
        }
        Some(state) if state.terminated.is_some() => {
            let terminated = state.terminated.as_ref().unwrap();
            ("terminated", terminated.reason.clone(), terminated.message.clone(), time_string(terminated.started_at.as_ref()))
        }
        _ => ("unknown", None, None, None),
    };
    let last_terminated = status
        .and_then(|s| s.last_state.as_ref())
        .and_then(|s| s.terminated.as_ref())
        .map(|t| TerminatedState {
            reason: t.reason.clone(),
            message: t.message.clone(),
            exit_code: t.exit_code,
            started_at: time_string(t.started_at.as_ref()),
            finished_at: time_string(t.finished_at.as_ref()),
        });
    let resources = spec.resources.as_ref();
    let quantity = |map: Option<&BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>, key: &str| {
        map.and_then(|m| m.get(key)).map(|q| q.0.clone())
    };
    ContainerSummary {
        name: spec.name.clone(),
        image: status.and_then(|s| s.image.clone().into()).unwrap_or_else(|| spec.image.clone().unwrap_or_default()),
        image_id: status.map(|s| s.image_id.clone()).filter(|id| !id.is_empty()),
        ready: status.map(|s| s.ready).unwrap_or(false),
        started: status.and_then(|s| s.started),
        restart_count: status.map(|s| s.restart_count).unwrap_or(0),
        state: state.to_string(),
        state_reason: reason,
        state_message: message,
        started_at,
        last_terminated,
        cpu_request: quantity(resources.and_then(|r| r.requests.as_ref()), "cpu"),
        cpu_limit: quantity(resources.and_then(|r| r.limits.as_ref()), "cpu"),
        memory_request: quantity(resources.and_then(|r| r.requests.as_ref()), "memory"),
        memory_limit: quantity(resources.and_then(|r| r.limits.as_ref()), "memory"),
        ports: spec
            .ports
            .as_ref()
            .map(|ports| {
                ports
                    .iter()
                    .map(|p| match &p.name {
                        Some(name) => format!("{}/{} ({name})", p.container_port, p.protocol.clone().unwrap_or_else(|| "TCP".into())),
                        None => format!("{}/{}", p.container_port, p.protocol.clone().unwrap_or_else(|| "TCP".into())),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Mirrors kubectl's pod printer: waiting/terminated container reasons win over the phase.
fn compute_status(pod: &Pod, containers: &[ContainerSummary], init_containers: &[ContainerSummary]) -> String {
    let status = pod.status.as_ref();
    if pod.metadata.deletion_timestamp.is_some() {
        return "Terminating".to_string();
    }
    if let Some(reason) = status.and_then(|s| s.reason.clone()) {
        if !reason.is_empty() {
            return reason;
        }
    }
    let phase = status.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".to_string());
    for (index, init) in init_containers.iter().enumerate() {
        match init.state.as_str() {
            "terminated" if init.state_reason.as_deref() == Some("Completed") => continue,
            "terminated" => {
                return format!("Init:{}", init.state_reason.clone().unwrap_or_else(|| "Error".into()));
            }
            "waiting" if init.state_reason.as_deref().map(|r| r != "PodInitializing").unwrap_or(false) => {
                return format!("Init:{}", init.state_reason.clone().unwrap());
            }
            _ => return format!("Init:{}/{}", index, init_containers.len()),
        }
    }
    for container in containers.iter().rev() {
        match container.state.as_str() {
            "waiting" => {
                if let Some(reason) = &container.state_reason {
                    return reason.clone();
                }
            }
            "terminated" if phase != "Running" => {
                if let Some(reason) = &container.state_reason {
                    return reason.clone();
                }
            }
            _ => {}
        }
    }
    phase
}

pub fn summarize_pod(pod: &Pod) -> PodSummary {
    let meta = &pod.metadata;
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();
    let statuses = status.and_then(|s| s.container_statuses.as_ref());
    let init_statuses = status.and_then(|s| s.init_container_statuses.as_ref());

    let containers: Vec<ContainerSummary> = spec
        .map(|s| {
            s.containers
                .iter()
                .map(|c| container_summary(c, statuses.and_then(|list| list.iter().find(|st| st.name == c.name))))
                .collect()
        })
        .unwrap_or_default();
    let init_containers: Vec<ContainerSummary> = spec
        .and_then(|s| s.init_containers.as_ref())
        .map(|list| {
            list.iter()
                .map(|c| container_summary(c, init_statuses.and_then(|st| st.iter().find(|x| x.name == c.name))))
                .collect()
        })
        .unwrap_or_default();

    let labels = meta.labels.clone().unwrap_or_default();
    let owner = meta.owner_references.as_ref().and_then(|refs| refs.first()).map(|r| OwnerRef { kind: r.kind.clone(), name: r.name.clone() });
    let workload = owner.as_ref().map(|o| {
        if o.kind == "ReplicaSet" {
            let name = match labels.get("pod-template-hash") {
                Some(hash) => o.name.strip_suffix(&format!("-{hash}")).unwrap_or(&o.name).to_string(),
                None => o.name.rsplit_once('-').map(|(base, _)| base.to_string()).unwrap_or_else(|| o.name.clone()),
            };
            OwnerRef { kind: "Deployment".to_string(), name }
        } else {
            o.clone()
        }
    });

    let conditions = status
        .and_then(|s| s.conditions.as_ref())
        .map(|list| {
            list.iter()
                .map(|c| Condition {
                    kind: c.type_.clone(),
                    status: c.status.clone(),
                    reason: c.reason.clone(),
                    message: c.message.clone(),
                    last_transition: time_string(c.last_transition_time.as_ref()),
                })
                .collect()
        })
        .unwrap_or_default();

    let pod_status = compute_status(pod, &containers, &init_containers);
    PodSummary {
        uid: meta.uid.clone().unwrap_or_default(),
        name: meta.name.clone().unwrap_or_default(),
        namespace: meta.namespace.clone().unwrap_or_default(),
        phase: status.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into()),
        status: pod_status,
        ready_count: containers.iter().filter(|c| c.ready).count(),
        total_count: containers.len(),
        restarts: containers.iter().map(|c| c.restart_count).sum(),
        created_at: time_string(meta.creation_timestamp.as_ref()),
        started_at: time_string(status.and_then(|s| s.start_time.as_ref())),
        deletion_timestamp: time_string(meta.deletion_timestamp.as_ref()),
        node: spec.and_then(|s| s.node_name.clone()),
        pod_ip: status.and_then(|s| s.pod_ip.clone()),
        host_ip: status.and_then(|s| s.host_ip.clone()),
        qos_class: status.and_then(|s| s.qos_class.clone()),
        service_account: spec.and_then(|s| s.service_account_name.clone()),
        owner,
        workload,
        labels,
        annotations: meta.annotations.clone().unwrap_or_default(),
        containers,
        init_containers,
        conditions,
    }
}

#[tauri::command]
pub async fn list_pods(cache: tauri::State<'_, ClientCache>, context: String, namespaces: Vec<String>) -> CommandResult<PodsResponse> {
    let client = cache.client_for(&context).await?;
    let tasks = namespaces.into_iter().map(|namespace| {
        let client = client.clone();
        async move {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let result = api.list(&ListParams::default()).await.map_err(AppError::from);
            (namespace, result)
        }
    });
    let mut pods = Vec::new();
    let mut errors = Vec::new();
    for (namespace, result) in futures::future::join_all(tasks).await {
        match result {
            Ok(list) => pods.extend(list.items.iter().map(summarize_pod)),
            Err(error) => errors.push(NamespaceError { namespace, error }),
        }
    }
    pods.sort_by(|a, b| a.namespace.cmp(&b.namespace).then_with(|| a.name.cmp(&b.name)));
    Ok(PodsResponse { context, pods, errors, fetched_at: now_string() })
}

#[tauri::command]
pub async fn get_pod_document(cache: tauri::State<'_, ClientCache>, context: String, namespace: String, name: String) -> CommandResult<ResourceDocument> {
    let client = cache.client_for(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut pod = api.get(&name).await?;
    pod.metadata.managed_fields = None;
    Ok(ResourceDocument {
        yaml: serde_yaml::to_string(&pod).map_err(AppError::other)?,
        json: serde_json::to_string_pretty(&pod).map_err(AppError::other)?,
    })
}

#[tauri::command]
pub async fn delete_pod(cache: tauri::State<'_, ClientCache>, context: String, namespace: String, name: String) -> CommandResult<String> {
    let client = cache.client_for(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(name)
}
