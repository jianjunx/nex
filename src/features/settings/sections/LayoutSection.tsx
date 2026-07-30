import { Button } from "@/components/ui/button";
import { useUiStore } from "../../../stores/ui.store";
import { SECTION_HEADER } from "./_shared";

export function LayoutSection() {
  const resetLayoutDims = useUiStore((s) => s.resetLayoutDims);

  return (
    // ④ Layout — sizes only; panel visibility is never touched.
    <section>
      <div className={SECTION_HEADER}>布局</div>
      <div className="space-y-1.5">
        <Button variant="outline" size="sm" onClick={resetLayoutDims}>恢复默认</Button>
        <p className="text-xs text-[var(--text-tertiary)]">
          侧栏 320px · 终端 200px · 编辑器 480px（仅重置尺寸，不影响显示状态）
        </p>
      </div>
    </section>
  );
}
