//! Apps launched from Finder/Dock get a minimal PATH, so kubeconfig exec plugins
//! (aws, gke-gcloud-auth-plugin, ...) may not resolve. Borrow the login shell PATH once.

use crate::models::{EnvironmentInfo, ExecPluginInfo};
use std::path::Path;
use std::env;
use std::process::Command;
use std::time::Duration;

const FALLBACK_DIRS: &[&str] = &["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

pub fn fix_path() {
    #[cfg(windows)]
    {
        return;
    }
    #[allow(unreachable_code)]
    {
        let current = env::var("PATH").unwrap_or_default();
        let mut entries: Vec<String> = Vec::new();

        if let Some(shell_path) = login_shell_path() {
            entries.extend(shell_path.split(':').filter(|p| !p.is_empty()).map(str::to_string));
        }
        entries.extend(current.split(':').filter(|p| !p.is_empty()).map(str::to_string));
        for dir in FALLBACK_DIRS {
            entries.push(dir.to_string());
        }
        if let Some(home) = env::var_os("HOME") {
            let home = home.to_string_lossy();
            entries.push(format!("{home}/.local/bin"));
            entries.push(format!("{home}/.krew/bin"));
            entries.push(format!("{home}/google-cloud-sdk/bin"));
        }

        let mut deduped: Vec<String> = Vec::new();
        for entry in entries {
            if !deduped.contains(&entry) {
                deduped.push(entry);
            }
        }
        env::set_var("PATH", deduped.join(":"));
    }
}

fn login_shell_path() -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut child = Command::new(&shell)
        .args(["-l", "-c", "printf '%s' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn resolve_command(command: &str) -> Option<String> {
    let path = Path::new(command);
    if path.is_absolute() || command.contains('/') {
        return path.exists().then(|| command.to_string());
    }
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths).map(|dir| dir.join(command)).find(|candidate| candidate.is_file()).map(|c| c.to_string_lossy().to_string())
    })
}

pub fn exec_plugins() -> Vec<ExecPluginInfo> {
    let Ok(kubeconfig) = kube::config::Kubeconfig::read() else {
        return Vec::new();
    };
    kubeconfig
        .contexts
        .iter()
        .filter_map(|named| {
            let user = named.context.as_ref()?.user.clone()?;
            let exec = kubeconfig.auth_infos.iter().find(|a| a.name == user)?.auth_info.as_ref()?.exec.as_ref()?;
            let command = exec.command.clone()?;
            Some(ExecPluginInfo { context: named.name.clone(), resolved: resolve_command(&command), command })
        })
        .collect()
}

#[tauri::command]
pub fn environment_info() -> EnvironmentInfo {
    EnvironmentInfo {
        path: env::var("PATH").unwrap_or_default(),
        home: env::var("HOME").ok(),
        kubeconfig_env: env::var("KUBECONFIG").ok(),
        shell: env::var("SHELL").ok(),
        exec_plugins: exec_plugins(),
    }
}
