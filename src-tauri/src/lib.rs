mod devtools;
mod env_path;
mod kube_client;
mod logs;
mod models;
mod pods;
mod workloads;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_path::fix_path();
    tauri::Builder::default()
        .manage(kube_client::ClientCache::default())
        .manage(logs::LogStreams::default())
        .invoke_handler(tauri::generate_handler![
            env_path::environment_info,
            kube_client::list_contexts,
            kube_client::list_namespaces,
            kube_client::probe_namespace,
            pods::list_pods,
            pods::get_pod_document,
            pods::delete_pod,
            workloads::list_workloads,
            workloads::get_workload_document,
            workloads::restart_workload,
            logs::start_log_stream,
            logs::stop_log_stream,
            logs::stop_all_log_streams,
            devtools::open_devtools
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod smoke {
    //! Live smoke tests against the developer's kubeconfig. Run explicitly:
    //! `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture`
    //! Env: PODHARBOR_CONTEXT (default: current context), PODHARBOR_NAMESPACE (default: context namespace).
    use super::*;
    use futures::{AsyncBufReadExt, TryStreamExt};

    fn target() -> (String, String) {
        let info = kube_client::read_contexts().expect("kubeconfig");
        let ctx = std::env::var("PODHARBOR_CONTEXT")
            .ok()
            .or_else(|| info.contexts.iter().find(|c| c.is_current).map(|c| c.name.clone()))
            .expect("a context");
        let ns = std::env::var("PODHARBOR_NAMESPACE")
            .ok()
            .or_else(|| info.contexts.iter().find(|c| c.name == ctx).and_then(|c| c.namespace.clone()))
            .unwrap_or_else(|| "default".to_string());
        (ctx, ns)
    }

    #[test]
    #[ignore = "requires a local kubeconfig"]
    fn reads_contexts() {
        let info = kube_client::read_contexts().expect("kubeconfig readable");
        println!("kubeconfig: {:?}", info.paths);
        for c in &info.contexts {
            println!("{} cluster={} ns={:?} auth={} current={}", c.name, c.cluster, c.namespace, c.auth, c.is_current);
        }
        assert!(!info.contexts.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn lists_pods_and_workloads() {
        env_path::fix_path();
        let (ctx, ns) = target();
        let cache = kube_client::ClientCache::default();
        let client = cache.client_for(&ctx).await.expect("client");
        let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client.clone(), &ns);
        let list = api.list(&kube::api::ListParams::default()).await.expect("pods");
        let pods: Vec<_> = list.items.iter().map(pods::summarize_pod).collect();
        println!("{ctx}/{ns}: {} pods", pods.len());
        for p in pods.iter().take(8) {
            println!(
                "  {:<55} {:<18} {}/{} restarts={} workload={:?} image={}",
                p.name,
                p.status,
                p.ready_count,
                p.total_count,
                p.restarts,
                p.workload.as_ref().map(|w| format!("{}/{}", w.kind, w.name)),
                p.containers.first().map(|c| c.image.as_str()).unwrap_or("-")
            );
        }
        assert!(!pods.is_empty());
        let json = serde_json::to_string(&pods[0]).expect("serializable");
        assert!(json.contains("\"readyCount\""));

        let deployments: kube::Api<k8s_openapi::api::apps::v1::Deployment> = kube::Api::namespaced(client, &ns);
        let dlist = deployments.list(&kube::api::ListParams::default()).await.expect("deployments");
        println!("  {} deployments", dlist.items.len());

        // namespaces at cluster scope: expected to be forbidden for restricted roles, must map cleanly
        let ns_api: kube::Api<k8s_openapi::api::core::v1::Namespace> = kube::Api::all(cache.client_for(&ctx).await.unwrap());
        match ns_api.list(&kube::api::ListParams::default()).await {
            Ok(l) => println!("  namespaces: {}", l.items.len()),
            Err(e) => {
                let err: models::AppError = e.into();
                println!("  namespaces: {} ({})", err.kind, err.message);
            }
        }
    }

    #[tokio::test]
    #[ignore]
    async fn streams_some_log_lines() {
        env_path::fix_path();
        let (ctx, ns) = target();
        let cache = kube_client::ClientCache::default();
        let client = cache.client_for(&ctx).await.expect("client");
        let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::namespaced(client, &ns);
        let list = api.list(&kube::api::ListParams::default().limit(1)).await.expect("pods");
        let pod = list.items.first().and_then(|p| p.metadata.name.clone()).expect("a pod");
        let params = kube::api::LogParams { tail_lines: Some(5), timestamps: true, ..Default::default() };
        let stream = api.log_stream(&pod, &params).await.expect("log stream");
        let mut lines = stream.lines();
        let mut count = 0;
        while let Some(line) = lines.try_next().await.expect("line") {
            let parsed = logs::split_timestamp_for_test(&line);
            println!("  [{}] {:?} {}", pod, parsed.timestamp, parsed.text.chars().take(80).collect::<String>());
            count += 1;
        }
        println!("  {count} lines");
    }
}
