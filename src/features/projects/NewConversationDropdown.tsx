import { useEffect, useState } from "react";
import { Loader2, Plus, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";
import { useProjectStore } from "../../stores/project.store";
import { useUiStore } from "../../stores/ui.store";
import type { Conversation, ServerDescriptor, SessionTarget } from "../../bridge/tauri";

function errorMessage(err: unknown): string {
  if (
    err && typeof err === "object" && "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * Compare two semver-ish version strings (e.g. "0.64.2" vs "0.65.0").
 * Returns negative if `a < b`, zero if equal, positive if `a > b`. Versions
 * with the same major/minor/patch but a pre-release suffix (`-beta.1`) sort
 * before the same version without one — matching semver's intuition.
 *
 * We don't pull in the `semver` package: registry versions are always
 * `x.y.z` (or `x.y.z-prerelease`) and we only need ordering, not range
 * matching or normalization. Tail-recursion-free; handles the common shapes
 * without dragging in ~150KB.
 */
function compareVersions(a: string, b: string): number {
  const parsePart = (s: string): [number[], string | null] => {
    const dash = s.indexOf("-");
    const numeric = dash === -1 ? s : s.slice(0, dash);
    const prerelease = dash === -1 ? null : s.slice(dash + 1);
    const nums = numeric.split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    // Pad to at least 3 components so "0.64" compares correctly to "0.64.0".
    while (nums.length < 3) nums.push(0);
    return [nums, prerelease];
  };
  const [aNums, aPre] = parsePart(a);
  const [bNums, bPre] = parsePart(b);
  for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
    const av = aNums[i] ?? 0;
    const bv = bNums[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  // Numeric parts equal: a version *with* a pre-release sorts *before* the
  // same version without one. Empty pre-release is the "release" form.
  if (aPre === bPre) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return aPre.localeCompare(bPre);
}

/** True when an installed-but-outdated registry entry needs the badge. */
function isUpdateAvailable(server: ServerDescriptor): boolean {
  if (server.kind !== "registry") return false;
  if (!server.installedVersion) return false;
  if (!server.version) return false;
  return compareVersions(server.installedVersion, server.version) < 0;
}

// 列表项 stagger 入场（前 12 条，tw-animate-css 的 fade-in；fill-mode 经 inline style）。
const ITEM_ENTER = "animate-in fade-in-0 duration-150";
// hover 左侧强调色条，与对话页签轮廓（F5）呼应。
const ITEM_ACCENT =
  "before:absolute before:left-0 before:top-1/4 before:bottom-1/4 before:w-0 before:rounded before:bg-[var(--accent)] before:opacity-0 before:transition-all before:duration-150 hover:before:w-0.5 hover:before:opacity-100";

interface Props {
  triggerSize: "icon" | "icon-sm";
}

export function NewConversationDropdown({ triggerSize }: Props) {
  const open = useUiStore((s) => s.newConversationOpen);
  const openNewConversation = useUiStore((s) => s.openNewConversation);
  const closeNewConversation = useUiStore((s) => s.closeNewConversation);
  const openSettings = useUiStore((s) => s.openSettings);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const servers = useAgentStore((s) => s.servers);
  const serversLoading = useAgentStore((s) => s.serversLoading);
  const serversLoadedAt = useAgentStore((s) => s.serversLoadedAt);
  const loadServers = useAgentStore((s) => s.loadServers);
  const refreshRegistry = useAgentStore((s) => s.refreshRegistry);
  const createSession = useAgentStore((s) => s.createSession);
  const createConversation = useConversationStore((s) => s.createConversation);
  const closeTab = useConversationStore((s) => s.closeTab);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 新鲜度守卫，写法同 AgentsSection：仅当列表为空或上次成功加载超过一分钟
  // 才在打开时回后端；刷新按钮不受此约束。
  useEffect(() => {
    if (!open) return;
    if (serversLoading) return;
    if (servers.length > 0 && Date.now() - serversLoadedAt < 60_000) return;
    void loadServers();
  }, [open, servers.length, serversLoading, serversLoadedAt, loadServers]);

  // 语义搬自旧新建会话模态框的 handleCreate：createConversation 立即开标签
  // → 关面板 → createSession 后台握手（失败写 agent.store 共享 error，现状一致）。
  // 拆成两段 try：建标签前的失败只出错误行；建标签后的任何同步失败回滚标签。
  const handleCreate = async (selected: ServerDescriptor) => {
    if (!project || creatingId) return;
    setCreatingId(selected.id);
    setError(null);
    let conv: Conversation;
    try {
      conv = await createConversation(project.id, selected.id);
    } catch (err) {
      setError(errorMessage(err));
      setCreatingId(null);
      return;
    }
    try {
      const target: SessionTarget =
        selected.kind === "custom"
          ? { type: "custom", id: selected.id }
          : { type: "registry", id: selected.id };
      setCreatingId(null);
      closeNewConversation();
      void createSession(conv.id, target, project.path).catch((err) => {
        useAgentStore.setState({ error: errorMessage(err) });
      });
    } catch (err) {
      closeTab(conv.id);
      setError(errorMessage(err));
      setCreatingId(null);
    }
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setError(null); // R4：每次打开清空上次残留的错误行
          openNewConversation();
        } else {
          closeNewConversation();
        }
      }}
    >
      {/* Radix 触发器只经 onPointerDown/onKeyDown 开合并经 onOpenChange 汇回
          store（react-dropdown-menu dist L77-90，无 onClick 路径）。
          严禁另接 onClick toggle：真机里 pointerdown 翻转一次后 click 会再翻转
          一次，按钮无法开关（Playwright 实测；jsdom fireEvent.click 暴露不了，
          故测试一律用 fireEvent.pointerDown，见技术背景实测条目）。 */}
      <DropdownMenuTrigger asChild>
        <Button size={triggerSize} variant="ghost" aria-label="新建会话">
          <Plus size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[320px]">
        <div className="flex items-center justify-between gap-2 px-2 pt-1">
          <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
            选择智能体
          </DropdownMenuLabel>
          <Button
            variant="ghost"
            size="icon-xs"
            title="刷新智能体注册表"
            disabled={serversLoading}
            onClick={() => void refreshRegistry()}
          >
            <RotateCw size={12} className={serversLoading ? "animate-spin" : ""} />
          </Button>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {serversLoading && servers.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)]">
              <Loader2 size={12} className="animate-spin" />
              正在加载智能体列表…
            </div>
          )}
          {!serversLoading && servers.length === 0 && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)]">
              <span>暂无可用智能体</span>
              <Button
                variant="ghost"
                size="icon-xs"
                title="刷新智能体注册表"
                onClick={() => void refreshRegistry()}
              >
                <RotateCw size={12} />
              </Button>
            </div>
          )}
          {servers.map((s, i) => (
            <DropdownMenuItem
              key={s.id}
              disabled={creatingId !== null}
              // Radix 默认点 Item 即关菜单；关的时机由我们控制（成功即关、
              // 失败保持开），故阻止默认。
              onSelect={(e) => {
                e.preventDefault();
                void handleCreate(s);
              }}
              className={`${ITEM_ENTER} ${ITEM_ACCENT} flex-col items-start gap-0.5 px-3 py-2`}
              style={
                i < 12
                  ? { animationDelay: `${i * 20}ms`, animationFillMode: "both" }
                  : undefined
              }
            >
              <div className="flex w-full items-center gap-2">
                <span className="font-medium text-sm">{s.name}</span>
                {s.version && (
                  <span className="text-xs text-[var(--text-tertiary)]">v{s.version}</span>
                )}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--overlay-ghost)] text-[var(--text-tertiary)]">
                  {s.kind === "custom" ? "自定义" : "注册表"}
                </span>
                {isUpdateAvailable(s) && (
                  <span
                    title={`当前 v${s.installedVersion}，可更新到 v${s.version}`}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] font-medium"
                  >
                    有更新
                  </span>
                )}
                {creatingId === s.id && (
                  <Loader2 size={12} className="ml-auto animate-spin text-[var(--accent)]" />
                )}
              </div>
              {s.description && (
                <div className="w-full text-xs text-[var(--text-tertiary)] truncate">
                  {s.description}
                </div>
              )}
            </DropdownMenuItem>
          ))}
        </div>

        {error && <p className="px-3 py-1.5 text-xs text-[var(--error)]">{error}</p>}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            closeNewConversation();
            setSettingsSection("agents");
            openSettings();
          }}
        >
          管理智能体…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
