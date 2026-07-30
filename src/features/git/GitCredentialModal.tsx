import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { gitCredentialRespond, onGitCredentialRequest } from "../../bridge/tauri";
import { useGitStore } from "../../stores/git.store";
import { useGitCredentialStore } from "./credentialRequest.store";

/** Host portion of a remote URL, for display. Mirrors Rust host_of(). */
function hostOf(url: string): string {
  const afterScheme = url.split("://")[1] ?? url;
  const authority = afterScheme.split("/")[0] ?? "";
  const noUser = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return noUser.split(":")[0] ?? noUser;
}

/**
 * Root-mounted modal pairing with the Rust GitCredentialBroker: a
 * `git-credential-request` event pushes a prompt; submit/cancel answer via
 * `git_credential_respond`. Credentials are never persisted — "remember" is
 * a memory-only session cache on the backend.
 */
export function GitCredentialModal() {
  const queue = useGitCredentialStore((s) => s.queue);
  const pushRequest = useGitCredentialStore((s) => s.pushRequest);
  const removeRequest = useGitCredentialStore((s) => s.removeRequest);
  const current = queue[0] ?? null;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const un = onGitCredentialRequest((req) => {
      pushRequest(req);
      useGitStore.getState().appendLog(`凭据请求：${hostOf(req.url)}`);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [pushRequest]);

  // Prefill fields whenever a new request becomes the active prompt.
  useEffect(() => {
    setUsername(current?.usernameHint ?? "");
    setPassword("");
    setRemember(false);
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.requestId]);

  const respond = async (withCredential: boolean) => {
    if (!current || sending) return;
    setSending(true);
    try {
      await gitCredentialRespond(
        current.requestId,
        withCredential ? username || null : null,
        withCredential ? password || null : null,
        withCredential ? remember : false,
      );
    } finally {
      removeRequest(current.requestId);
    }
  };

  const isSsh = current?.kind === "ssh-passphrase";
  const secretLabel = isSsh ? "密钥口令" : "密码 / 访问令牌";

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) void respond(false);
      }}
    >
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Git 认证</DialogTitle>
          <DialogDescription>
            {current
              ? `${hostOf(current.url)} 需要凭据（${isSsh ? "SSH 密钥口令" : "HTTPS"}）`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {current && (
          <div className="grid gap-3">
            {!isSsh && (
              <div className="grid gap-1.5">
                <Label htmlFor="git-cred-user">用户名</Label>
                <Input
                  id="git-cred-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="用户名"
                  autoFocus
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="git-cred-pass">{secretLabel}</Label>
              <Input
                id="git-cred-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={secretLabel}
                autoFocus={isSsh}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void respond(true);
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              本次会话记住（仅内存）
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={sending} onClick={() => void respond(false)}>
            取消
          </Button>
          <Button disabled={sending || !password} onClick={() => void respond(true)}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
