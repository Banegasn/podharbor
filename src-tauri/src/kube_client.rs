use crate::models::{AppError, CommandResult, KubeContext, KubeconfigInfo};
use k8s_openapi::api::core::v1::Namespace;
use kube::api::ListParams;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ClientCache {
    clients: Mutex<HashMap<String, Client>>,
}

impl ClientCache {
    pub async fn client_for(&self, context: &str) -> CommandResult<Client> {
        if let Some(client) = self.clients.lock().await.get(context) {
            return Ok(client.clone());
        }
        let kubeconfig = Kubeconfig::read()?;
        if !kubeconfig.contexts.iter().any(|c| c.name == context) {
            return Err(AppError::config(format!("Context '{context}' not found in kubeconfig")));
        }
        let options = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let client = Client::try_from(config)?;
        self.clients.lock().await.insert(context.to_string(), client.clone());
        Ok(client)
    }

    pub async fn clear(&self) {
        self.clients.lock().await.clear();
    }
}

pub fn kubeconfig_paths() -> Vec<PathBuf> {
    if let Some(value) = env::var_os("KUBECONFIG") {
        let paths: Vec<PathBuf> = env::split_paths(&value).filter(|p| !p.as_os_str().is_empty()).collect();
        if !paths.is_empty() {
            return paths;
        }
    }
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")).map(PathBuf::from);
    home.map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default()
}

pub fn read_contexts() -> CommandResult<KubeconfigInfo> {
    let kubeconfig = Kubeconfig::read()?;
    let current = kubeconfig.current_context.clone();
    let contexts = kubeconfig
        .contexts
        .iter()
        .map(|named| {
            let ctx = named.context.clone().unwrap_or_default();
            let server = kubeconfig
                .clusters
                .iter()
                .find(|c| c.name == ctx.cluster)
                .and_then(|c| c.cluster.as_ref())
                .and_then(|c| c.server.clone());
            let auth = kubeconfig
                .auth_infos
                .iter()
                .find(|a| Some(&a.name) == ctx.user.as_ref())
                .and_then(|a| a.auth_info.as_ref())
                .map(|info| {
                    if let Some(exec) = &info.exec {
                        let command = exec.command.clone().unwrap_or_default();
                        let binary = command.rsplit(['/', '\\']).next().unwrap_or(&command).to_string();
                        format!("exec:{binary}")
                    } else if info.token.is_some() || info.token_file.is_some() {
                        "token".to_string()
                    } else if info.client_certificate.is_some() || info.client_certificate_data.is_some() {
                        "certificate".to_string()
                    } else if info.username.is_some() {
                        "basic".to_string()
                    } else if info.auth_provider.is_some() {
                        "auth-provider".to_string()
                    } else {
                        "none".to_string()
                    }
                })
                .unwrap_or_else(|| "none".to_string());
            KubeContext {
                name: named.name.clone(),
                cluster: ctx.cluster.clone(),
                server,
                namespace: ctx.namespace.clone(),
                user: ctx.user.clone().unwrap_or_default(),
                auth,
                is_current: current.as_deref() == Some(named.name.as_str()),
            }
        })
        .collect();
    Ok(KubeconfigInfo {
        paths: kubeconfig_paths().iter().map(|p| p.to_string_lossy().to_string()).collect(),
        contexts,
    })
}

#[tauri::command]
pub async fn list_contexts(cache: tauri::State<'_, ClientCache>) -> CommandResult<KubeconfigInfo> {
    cache.clear().await;
    read_contexts()
}

#[tauri::command]
pub async fn list_namespaces(cache: tauri::State<'_, ClientCache>, context: String) -> CommandResult<Vec<String>> {
    let client = cache.client_for(&context).await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await?;
    let mut names: Vec<String> = list.items.into_iter().filter_map(|ns| ns.metadata.name).collect();
    names.sort();
    Ok(names)
}

/// Cheap probe used by the UI to validate a namespace the user typed by hand
/// when the role cannot list namespaces at cluster scope.
#[tauri::command]
pub async fn probe_namespace(cache: tauri::State<'_, ClientCache>, context: String, namespace: String) -> CommandResult<usize> {
    use k8s_openapi::api::core::v1::Pod;
    let client = cache.client_for(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let list = api.list(&ListParams::default().limit(1)).await?;
    let remaining = list.metadata.remaining_item_count.unwrap_or(0) as usize;
    Ok(list.items.len() + remaining)
}
