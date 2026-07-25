import { useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@glinui/ui";

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const window = getCurrentWindow();
    // Update initial state and listen for resize changes
    window.isMaximized().then(setIsMaximized).catch(() => {});

    const unlisten = window.onResized(() => {
      window.isMaximized().then(setIsMaximized).catch(() => {});
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const window = getCurrentWindow();

  return (
    <div className="flex items-center gap-0.5 ml-1">
      <Button size="sm" variant="ghost" onClick={() => window.minimize()}>
        <Minus size={14} />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => window.toggleMaximize()}>
        {isMaximized ? <Copy size={12} /> : <Square size={12} />}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => window.close()}>
        <X size={14} />
      </Button>
    </div>
  );
}
