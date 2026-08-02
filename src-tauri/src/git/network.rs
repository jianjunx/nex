use std::path::Path;
use std::process::{Command, Output};

use crate::error::NexError;

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
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NexError::Git("未找到 git 命令：请安装 Git 并确保其加入 PATH".to_string())
        } else {
            NexError::Git(format!("git 启动失败：{e}"))
        }
    })
}

/// 从 git stderr 提取单行错误信息：优先 error:/fatal:/hint: 行，否则最后非空行。
fn stderr_line(stderr: &[u8]) -> String {
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

fn run_git(repo: Option<&Path>, args: &[&str]) -> Result<String, NexError> {
    let out = run_git_output(repo, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(NexError::Git(stderr_line(&out.stderr)))
    }
}

/// `git fetch <remote>`（默认 refspecs，同 `git fetch` 的语义）。
pub fn fetch_remote(repo_path: &Path, remote: &str) -> Result<(), NexError> {
    run_git(Some(repo_path), &["fetch", remote]).map(|_| ())
}

/// `git pull <remote>`：fetch 后合并远端 HEAD 到当前分支（与旧实现
/// FETCH_HEAD 合并语义一致）；非快进冲突由 git 自身报错上抛。
pub fn pull_remote(repo_path: &Path, remote: &str) -> Result<(), NexError> {
    run_git(Some(repo_path), &["pull", remote]).map(|_| ())
}

/// `git push <remote> <branch>`；非快进拒绝映射为既有中文文案
/// （新版 git 文案为 "(fetch first)"，旧版为 "(non-fast-forward)"）。
pub fn push_remote(repo_path: &Path, remote: &str, branch: &str) -> Result<(), NexError> {
    let out = run_git_output(Some(repo_path), &["push", remote, branch])?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("non-fast-forward") || stderr.contains("fetch first") {
        return Err(NexError::Git("推送被拒绝：非快进，请先拉取合并".to_string()));
    }
    Err(NexError::Git(stderr_line(&out.stderr)))
}

/// `git clone <url> <dest>`：克隆到 dest（与旧 libgit2 实现一致）。
pub fn clone_repo(url: &str, dest: &Path) -> Result<(), NexError> {
    let dest_str = dest
        .to_str()
        .ok_or_else(|| NexError::Git("克隆目标路径无效".to_string()))?;
    run_git(None, &["clone", url, dest_str]).map(|_| ())
}
