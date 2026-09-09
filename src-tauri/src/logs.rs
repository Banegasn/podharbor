use crate::kube_client::ClientCache;
use crate::models::*;
use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::LogParams;
use kube::Api;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tauri::async_runtime::JoinHandle;

pub const LOG_BATCH_EVENT: &str = "log-batch";
pub const LOG_END_EVENT: &str = "log-end";
const BATCH_MAX_LINES: usize = 500;
const BATCH_MAX_WAIT: Duration = Duration::from_millis(120);

#[derive(Default)]
pub struct LogStreams {
    next_id: AtomicU64,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

fn split_timestamp(raw: &str) -> LogLine {
    // With `timestamps: true` the kubelet prefixes each line with an RFC3339 timestamp.
    match raw.split_once(' ') {
        Some((ts, rest)) if ts.len() >= 20 && ts.as_bytes()[4] == b'-' && ts.ends_with('Z') => {
            LogLine { timestamp: Some(ts.to_string()), text: rest.to_string() }
        }
        _ => LogLine { timestamp: None, text: raw.to_string() },
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_log_stream(
    app: AppHandle,
    cache: tauri::State<'_, ClientCache>,
    streams: tauri::State<'_, LogStreams>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail_lines: Option<i64>,
    since_seconds: Option<i64>,
    follow: Option<bool>,
    previous: Option<bool>,
) -> CommandResult<LogStreamHandle> {
    let client = cache.client_for(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let container_name = match &container {
        Some(name) => name.clone(),
        None => {
            let spec = api.get(&pod).await?;
            spec.spec.and_then(|s| s.containers.first().map(|c| c.name.clone())).unwrap_or_default()
        }
    };
    let params = LogParams {
        container: Some(container_name.clone()),
        follow: follow.unwrap_or(true),
        tail_lines: tail_lines.or(Some(500)),
        since_seconds,
        previous: previous.unwrap_or(false),
        timestamps: true,
        ..Default::default()
    };
    let stream_id = format!("{}-{}", pod, streams.next_id.fetch_add(1, Ordering::Relaxed));
    let handle = LogStreamHandle { stream_id: stream_id.clone(), namespace: namespace.clone(), pod: pod.clone(), container: container_name };

    let task_id = stream_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let end = |error: Option<AppError>| LogStreamEnd { stream_id: task_id.clone(), error };
        let stream = match api.log_stream(&pod, &params).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = app.emit(LOG_END_EVENT, end(Some(error.into())));
                return;
            }
        };
        let mut lines = stream.lines();
        let mut buffer: Vec<LogLine> = Vec::new();
        let mut result: Option<AppError> = None;
        loop {
            let next = tokio::time::timeout(BATCH_MAX_WAIT, lines.try_next()).await;
            match next {
                Ok(Ok(Some(line))) => {
                    buffer.push(split_timestamp(&line));
                    if buffer.len() < BATCH_MAX_LINES {
                        continue;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(error)) => {
                    result = Some(AppError::other(error.to_string()));
                    break;
                }
                Err(_elapsed) => {}
            }
            if !buffer.is_empty() {
                let batch = LogBatch { stream_id: task_id.clone(), lines: std::mem::take(&mut buffer) };
                if app.emit(LOG_BATCH_EVENT, batch).is_err() {
                    return;
                }
            }
        }
        if !buffer.is_empty() {
            let _ = app.emit(LOG_BATCH_EVENT, LogBatch { stream_id: task_id.clone(), lines: buffer });
        }
        let _ = app.emit(LOG_END_EVENT, end(result));
    });
    streams.tasks.lock().await.insert(stream_id, task);
    Ok(handle)
}

#[tauri::command]
pub async fn stop_log_stream(streams: tauri::State<'_, LogStreams>, stream_id: String) -> CommandResult<()> {
    if let Some(task) = streams.tasks.lock().await.remove(&stream_id) {
        task.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_all_log_streams(streams: tauri::State<'_, LogStreams>) -> CommandResult<usize> {
    let mut tasks = streams.tasks.lock().await;
    let count = tasks.len();
    for (_, task) in tasks.drain() {
        task.abort();
    }
    Ok(count)
}

#[cfg(test)]
pub fn split_timestamp_for_test(raw: &str) -> LogLine {
    split_timestamp(raw)
}
