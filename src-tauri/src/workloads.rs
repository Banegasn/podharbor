use crate::kube_client::ClientCache;
use crate::models::*;
use crate::pods::{now_string, time_string};
use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use kube::api::{ListParams, Patch, PatchParams};
use kube::Api;

fn deployment_summary(d: &Deployment) -> WorkloadSummary {
    let spec = d.spec.as_ref();
    let status = d.status.as_ref();
    let template = spec.map(|s| &s.template);
    WorkloadSummary {
        uid: d.metadata.uid.clone().unwrap_or_default(),
        kind: "Deployment".to_string(),
        name: d.metadata.name.clone().unwrap_or_default(),
        namespace: d.metadata.namespace.clone().unwrap_or_default(),
        desired: spec.and_then(|s| s.replicas).unwrap_or(1),
        ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
        updated: status.and_then(|s| s.updated_replicas).unwrap_or(0),
        available: status.and_then(|s| s.available_replicas).unwrap_or(0),
        images: template
            .and_then(|t| t.spec.as_ref())
            .map(|s| s.containers.iter().filter_map(|c| c.image.clone()).collect())
            .unwrap_or_default(),
        created_at: time_string(d.metadata.creation_timestamp.as_ref()),
        selector: spec.and_then(|s| s.selector.match_labels.clone()).unwrap_or_default(),
        strategy: spec.and_then(|s| s.strategy.as_ref()).and_then(|s| s.type_.clone()),
        paused: spec.and_then(|s| s.paused).unwrap_or(false),
        conditions: status
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
            .unwrap_or_default(),
        labels: d.metadata.labels.clone().unwrap_or_default(),
    }
}

fn statefulset_summary(s: &StatefulSet) -> WorkloadSummary {
    let spec = s.spec.as_ref();
    let status = s.status.as_ref();
    WorkloadSummary {
        uid: s.metadata.uid.clone().unwrap_or_default(),
        kind: "StatefulSet".to_string(),
        name: s.metadata.name.clone().unwrap_or_default(),
        namespace: s.metadata.namespace.clone().unwrap_or_default(),
        desired: spec.and_then(|x| x.replicas).unwrap_or(1),
        ready: status.and_then(|x| x.ready_replicas).unwrap_or(0),
        updated: status.and_then(|x| x.updated_replicas).unwrap_or(0),
        available: status.and_then(|x| x.available_replicas).unwrap_or(0),
        images: spec
            .and_then(|x| x.template.spec.as_ref())
            .map(|t| t.containers.iter().filter_map(|c| c.image.clone()).collect())
            .unwrap_or_default(),
        created_at: time_string(s.metadata.creation_timestamp.as_ref()),
        selector: spec.and_then(|x| x.selector.match_labels.clone()).unwrap_or_default(),
        strategy: spec.and_then(|x| x.update_strategy.as_ref()).and_then(|u| u.type_.clone()),
        paused: false,
        conditions: status
            .and_then(|x| x.conditions.as_ref())
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
            .unwrap_or_default(),
        labels: s.metadata.labels.clone().unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn list_workloads(cache: tauri::State<'_, ClientCache>, context: String, namespaces: Vec<String>) -> CommandResult<WorkloadsResponse> {
    let client = cache.client_for(&context).await?;
    let tasks = namespaces.into_iter().map(|namespace| {
        let client = client.clone();
        async move {
            let deployments: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let statefulsets: Api<StatefulSet> = Api::namespaced(client, &namespace);
            let params = ListParams::default();
            let (d, s) = futures::join!(deployments.list(&params), statefulsets.list(&params));
            (namespace, d.map_err(AppError::from), s.map_err(AppError::from))
        }
    });
    let mut workloads = Vec::new();
    let mut errors = Vec::new();
    for (namespace, deployments, statefulsets) in futures::future::join_all(tasks).await {
        match deployments {
            Ok(list) => workloads.extend(list.items.iter().map(deployment_summary)),
            Err(error) => errors.push(NamespaceError { namespace: namespace.clone(), error }),
        }
        match statefulsets {
            Ok(list) => workloads.extend(list.items.iter().map(statefulset_summary)),
            // A role that can read deployments but not statefulsets should not blank the namespace.
            Err(error) if error.kind != "forbidden" => errors.push(NamespaceError { namespace, error }),
            Err(_) => {}
        }
    }
    workloads.sort_by(|a, b| a.namespace.cmp(&b.namespace).then_with(|| a.name.cmp(&b.name)));
    Ok(WorkloadsResponse { context, workloads, errors, fetched_at: now_string() })
}

#[tauri::command]
pub async fn get_workload_document(
    cache: tauri::State<'_, ClientCache>,
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> CommandResult<ResourceDocument> {
    let client = cache.client_for(&context).await?;
    let (yaml, json) = match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            let mut item = api.get(&name).await?;
            item.metadata.managed_fields = None;
            (serde_yaml::to_string(&item).map_err(AppError::other)?, serde_json::to_string_pretty(&item).map_err(AppError::other)?)
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            let mut item = api.get(&name).await?;
            item.metadata.managed_fields = None;
            (serde_yaml::to_string(&item).map_err(AppError::other)?, serde_json::to_string_pretty(&item).map_err(AppError::other)?)
        }
        other => return Err(AppError::other(format!("Unsupported workload kind '{other}'"))),
    };
    Ok(ResourceDocument { yaml, json })
}

/// Equivalent of `kubectl rollout restart`: stamps the pod template so the controller rolls new pods.
#[tauri::command]
pub async fn restart_workload(cache: tauri::State<'_, ClientCache>, context: String, namespace: String, kind: String, name: String) -> CommandResult<String> {
    let client = cache.client_for(&context).await?;
    let patch = serde_json::json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now_string()
        }}}}
    });
    let params = PatchParams::default();
    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            api.patch(&name, &params, &Patch::Merge(&patch)).await?;
        }
        other => return Err(AppError::other(format!("Unsupported workload kind '{other}'"))),
    }
    Ok(name)
}
