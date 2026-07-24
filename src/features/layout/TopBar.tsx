import { Plus, PanelRight } from "lucide-react";
import { GlassButton } from "../../ui";
import { useUiStore } from "../../stores/ui.store";

export function TopBar() {
  const { toggleSidePanel, sidePanelVisible } = useUiStore();

  return (
    <div className="flex items-center h-10 px-3 gap-2 border-b border-white/[0.06] bg-[var(--glass-base-bg)] backdrop-blur-[40px]">
      {/* Project selector placeholder */}
      <GlassButton size="sm" variant="ghost">
        Projects ▾
      </GlassButton>

      {/* New conversation */}
      <GlassButton size="sm" variant="ghost">
        <Plus size={14} />
      </GlassButton>

      {/* Conversation tabs placeholder */}
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        <span className="text-xs text-[var(--text-tertiary)] px-2">No conversations</span>
      </div>

      {/* Panel toggle */}
      <GlassButton size="sm" variant="ghost" onClick={toggleSidePanel}>
        <PanelRight size={14} className={sidePanelVisible ? "text-[var(--accent)]" : ""} />
      </GlassButton>
    </div>
  );
}
