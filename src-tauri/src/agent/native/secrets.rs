//! Cross-platform system credential storage for native-agent provider keys.
//!
//! Linux sends values to Secret Service over stdin and Windows uses an
//! inherited process environment for PasswordVault. The macOS `security` CLI
//! requires its `-w` argument; the value is never persisted by Nex. Callers
//! may keep the legacy inline value when the platform service is unavailable.

#[cfg(any(target_os = "linux", windows))]
use std::io::Write;
use std::process::Command;
#[cfg(any(target_os = "linux", windows))]
use std::process::Stdio;

const SERVICE: &str = "com.nex.native-agent";

pub fn set(id: &str, secret: &str) -> Result<(), String> {
    validate_id(id)?;
    if secret.is_empty() {
        return Err("credential value is empty".to_string());
    }
    platform_set(id, secret)
}

pub fn get(id: &str) -> Result<String, String> {
    validate_id(id)?;
    platform_get(id)
}

pub fn delete(id: &str) -> Result<(), String> {
    validate_id(id)?;
    platform_delete(id)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("invalid credential id".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
fn run_with_stdin(mut command: Command, stdin: &str) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("credential service unavailable: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("credential service stdin unavailable")?
        .write_all(stdin.as_bytes())
        .map_err(|e| format!("credential service write failed: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("credential service failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn platform_set(id: &str, secret: &str) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/security");
    command.args([
        "add-generic-password",
        "-U",
        "-a",
        id,
        "-s",
        SERVICE,
        "-w",
        secret,
    ]);
    // `security` has no stdin secret option. Restricting this exception to the
    // platform tool is preferable to persisting the key in JSON.
    let output = command
        .output()
        .map_err(|e| format!("Keychain unavailable: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn platform_get(id: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-a", id, "-s", SERVICE, "-w"])
        .output()
        .map_err(|e| format!("Keychain unavailable: {e}"))?;
    output_text(output, "credential not found")
}

#[cfg(target_os = "macos")]
fn platform_delete(id: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-a", id, "-s", SERVICE])
        .output()
        .map_err(|e| format!("Keychain unavailable: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn platform_set(id: &str, secret: &str) -> Result<(), String> {
    let mut command = Command::new("secret-tool");
    command.args([
        "store",
        "--label=Nex Agent",
        "service",
        SERVICE,
        "account",
        id,
    ]);
    run_with_stdin(command, secret)
}

#[cfg(target_os = "linux")]
fn platform_get(id: &str) -> Result<String, String> {
    let output = Command::new("secret-tool")
        .args(["lookup", "service", SERVICE, "account", id])
        .output()
        .map_err(|e| format!("Secret Service unavailable: {e}"))?;
    output_text(output, "credential not found")
}

#[cfg(target_os = "linux")]
fn platform_delete(id: &str) -> Result<(), String> {
    let output = Command::new("secret-tool")
        .args(["clear", "service", SERVICE, "account", id])
        .output()
        .map_err(|e| format!("Secret Service unavailable: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(windows)]
fn powershell() -> Command {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command"]);
    command
}

#[cfg(windows)]
fn platform_set(id: &str, secret: &str) -> Result<(), String> {
    let script = r#"$v=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new(); try{$old=$v.Retrieve($env:NEX_SECRET_SERVICE,$env:NEX_SECRET_ID);$v.Remove($old)}catch{}; $c=[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new($env:NEX_SECRET_SERVICE,$env:NEX_SECRET_ID,$env:NEX_SECRET_VALUE);$v.Add($c)"#;
    let mut command = powershell();
    command
        .arg(script)
        .env("NEX_SECRET_SERVICE", SERVICE)
        .env("NEX_SECRET_ID", id)
        .env("NEX_SECRET_VALUE", secret);
    run_with_stdin(command, "")
}

#[cfg(windows)]
fn platform_get(id: &str) -> Result<String, String> {
    let script = r#"$v=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new();$c=$v.Retrieve($env:NEX_SECRET_SERVICE,$env:NEX_SECRET_ID);$c.RetrievePassword();[Console]::Out.Write($c.Password)"#;
    let output = powershell()
        .arg(script)
        .env("NEX_SECRET_SERVICE", SERVICE)
        .env("NEX_SECRET_ID", id)
        .output()
        .map_err(|e| format!("PasswordVault unavailable: {e}"))?;
    output_text(output, "credential not found")
}

#[cfg(windows)]
fn platform_delete(id: &str) -> Result<(), String> {
    let script = r#"$v=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new();$c=$v.Retrieve($env:NEX_SECRET_SERVICE,$env:NEX_SECRET_ID);$v.Remove($c)"#;
    let output = powershell()
        .arg(script)
        .env("NEX_SECRET_SERVICE", SERVICE)
        .env("NEX_SECRET_ID", id)
        .output()
        .map_err(|e| format!("PasswordVault unavailable: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn output_text(output: std::process::Output, missing: &str) -> Result<String, String> {
    if !output.status.success() {
        return Err(missing.to_string());
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        Err(missing.to_string())
    } else {
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_ids_are_strict() {
        assert!(validate_id("provider.openai-1").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../secret").is_err());
        assert!(validate_id("has space").is_err());
    }
}
