import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { IconBar } from "./IconBar";
import { useUiStore } from "../../stores/ui.store";

interface MainLayoutProps {
  mainContent: ReactNode;
  sidePanel: ReactNode;
}

export function MainLayout({ mainContent, sidePanel }: MainLayoutProps) {
  const { sidePanelVisible, sidePanelWidth } = useUiStore();

  return (
    <div className="flex flex-col h-full w-full">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {mainContent}
        </div>

        {/* Side panel */}
        {sidePanelVisible && (
          <div
            className="flex flex-col border-l border-white/[0.06] overflow-hidden"
            style={{ width: sidePanelWidth }}
          >
            <div className="flex-1 overflow-hidden">
              {sidePanel}
            </div>
          </div>
        )}

        {/* Icon bar */}
        <IconBar />
      </div>
    </div>
  );
}
