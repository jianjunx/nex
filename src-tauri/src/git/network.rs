use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use crate::error::NexError;

/// Upper bound for fetch/pull/push/clone. Without this a hung remote leaves
/// the UI spinner forever (audit #8). On timeout the child is killed.
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

/// 网络操作（fetch/pull/push/clone）统一委派系统 git，与 VSCode 行为一致。
///
/// 背景：libgit2/libssh2 的 SSH 栈与 GitHub sshd 存在协议不兼容——无口令
/// ed25519 密钥在认证阶段被服务器断开连接（`remote rejected authentication:
/// Failed getting response`），而系统 git + OpenSSH ssh.exe 认证正常；此外
/// libssh2 不读 `~/.ssh/config`、不支持 Git Credential Manager。委派 git 后：
/// - SSH：走 OpenSSH（~/.ssh/config、ssh-agent、无口令密钥全部生效）
/// - HTTPS：git 原生 credential helper（GCM → Windows 凭据管理器直接命中，
///   不再弹认证）
///
/// 终端提示被禁用（GIT_TERMINAL_PROMPT=0，无 TTY）；失败信息由 stderr 上抛。
/// GitCredentialBroker / GitCredentialModal 暂保留为休眠代码（Git 凭证栈
/// 自行处理 UI，如后续需要可在 GIT_ASKPASS 中复用弹窗）。
fn run_git_output(repo: Option<&Path>, args: &[&str]) -> Result<Output, NexError> {
    let mut cmd = Command::new("git");
    if let Some(repo) = repo {
        cmd.arg("-C").arg(repo);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // GUI 应用里 git.exe（控制台子系统）默认会弹黑框；拉取/获取时尤其明显。
    crate::win_process::no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NexError::Git("未找到 git 命令：请安装 Git 并确保其加入 PATH".to_string())
        } else {
            NexError::Git(format!("git 启动失败：{e}"))
        }
    })?;

    let deadline = Instant::now() + GIT_NETWORK_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|e| NexError::Git(format!("git 读取输出失败：{e}")));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(NexError::Git(format!(
                        "git 操作超时（{}s）",
                        GIT_NETWORK_TIMEOUT.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(NexError::Git(format!("git 等待失败：{e}")));
            }
        }
    }
}

/// 从 git stderr 提取单行摘要：优先 error:/fatal:/hint: 行，否则最后非空行。
fn stderr_summary(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|l| {
            let t = l.trim();
            t.starts_with("error:") || t.starts_with("fatal:") || t.starts_with("hint:")
        })
        .or_else(|| text.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("git 命令失败")
        .trim()
        .to_string()
}

/// 完整 stderr（供 UI 展开详情）；空则回退到摘要。
fn git_err_from_stderr(stderr: &[u8]) -> NexError {
    let full = String::from_utf8_lossy(stderr).trim().to_string();
    if full.is_empty() {
        NexError::Git(stderr_summary(stderr))
    } else {
        NexError::Git(full)
    }
}

fn run_git(repo: Option<&Path>, args: &[&str]) -> Result<String, NexError> {
    let out = run_git_output(repo, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(git_err_from_stderr(&out.stderr))
    }
}

/// Refuses values that git would parse as option flags (e.g. a malicious
/// remote named `--upload-pack=<cmd>`). Remotes/branches/URLs never need
/// to start with `-`.
fn validate_git_arg(kind: &str, value: &str) -> Result<(), NexError> {
    if value.starts_with('-') || value.is_empty() {
        return Err(NexError::Git(format!("非法的{kind}: {value}")));
    }
    Ok(())
}

/// `git fetch <remote>`（默认 refspecs，同 `git fetch` 的语义）。
pub fn fetch_remote(repo_path: &Path, remote: &str) -> Result<(), NexError> {
    validate_git_arg("远端名", remote)?;
    run_git(Some(repo_path), &["fetch", remote]).map(|_| ())
}

/// `git pull <remote> <current-branch>`。
///
/// 只传 `git pull <remote>` 时，未配置 upstream 的仓库会报
/// "did not specify a branch" / "no tracking information"——这是面板拉取
/// 失败的常见原因。显式带上当前分支名后行为与 VS Code 一致。
pub fn pull_remote(repo_path: &Path, remote: &str) -> Result<(), NexError> {
    validate_git_arg("远端名", remote)?;
    let branch = run_git(Some(repo_path), &["branch", "--show-current"])?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err(NexError::Git(
            "当前处于分离 HEAD，无法拉取。请先签出到本地分支。".into(),
        ));
    }
    validate_git_arg("分支名", &branch)?;
    run_git(Some(repo_path), &["pull", remote, &branch]).map(|_| ())
}

/// `git merge --no-edit <branch>`：把指定分支合并进当前 HEAD。
pub fn merge_branch(repo_path: &Path, branch: &str) -> Result<(), NexError> {
    validate_git_arg("分支名", branch)?;
    run_git(Some(repo_path), &["merge", "--no-edit", branch]).map(|_| ())
}

/// `git push <remote> <branch>`；非快进拒绝映射为既有中文文案
/// （新版 git 文案为 "(fetch first)"，旧版为 "(non-fast-forward)"）。
pub fn push_remote(repo_path: &Path, remote: &str, branch: &str) -> Result<(), NexError> {
    validate_git_arg("远端名", remote)?;
    validate_git_arg("分支名", branch)?;
    let out = run_git_output(Some(repo_path), &["push", remote, branch])?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("non-fast-forward") || stderr.contains("fetch first") {
        return Err(NexError::Git(
            "推送被拒绝：非快进，请先拉取合并".to_string(),
        ));
    }
    Err(git_err_from_stderr(&out.stderr))
}

/// `git clone <url> <dest>`：克隆到 dest（与旧 libgit2 实现一致）。
pub fn clone_repo(url: &str, dest: &Path) -> Result<(), NexError> {
    validate_git_arg("仓库 URL", url)?;
    let dest_str = dest
        .to_str()
        .ok_or_else(|| NexError::Git("克隆目标路径无效".to_string()))?;
    run_git(None, &["clone", url, dest_str]).map(|_| ())
}
