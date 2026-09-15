import { useUiStore } from "@/stores/ui.store";
import { FileTree } from "../files/FileTree";
import { GitPanel } from "../git/GitPanel";
import { SearchPanel } from "../search/SearchPanel";
export function SidePanel() {
  const tab = useUiStore((s) => s.sidePanelTab);
  return (
    <div className="nex-material-sidebar h-full min-h-0 overflow-hidden">
      {tab === "files" ? (
        <FileTree />
      ) : tab === "git" ? (
        <GitPanel />
      ) : (
        <SearchPanel />
      )}
    </div>
  );
}
