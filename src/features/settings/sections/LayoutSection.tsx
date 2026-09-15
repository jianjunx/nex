import { Button } from "@/components/ui/button";
import { useUiStore } from "../../../stores/ui.store";
import { SECTION_HEADER } from "./_shared";
import FineTuneCard from "@/components/agent-ui/beautiful-ui/FineTuneCard";

export function LayoutSection() {
  const resetLayoutDims = useUiStore((s) => s.resetLayoutDims);
  const side = useUiStore((s) => s.sidePanelWidth);

  return (
    // 仅重置尺寸，从不改面板可见性。
    <section>
      <div className={SECTION_HEADER}>布局</div>
      <div className="beautiful-ui nex-ui-tuning mb-5">
        <FineTuneCard
          fieldsOnly
          value={{ side }}
          fields={[
            {
              key: "side",
              label: "侧栏宽度",
              value: side,
              min: 240,
              max: 640,
              step: 10,
              suffix: "px",
            },
          ]}
          options={["工作台"]}
          labels={{
            title: "工作区尺寸",
            layout: "布局",
            type: "视图",
            placeholder: "调整面板尺寸",
            adjust: "调整",
            edited: "已调整",
          }}
          onChange={({ values }) => {
            if (values.side !== undefined)
              useUiStore.getState().setSidePanelWidth(values.side);
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Button variant="outline" size="sm" onClick={resetLayoutDims}>
          恢复默认
        </Button>
        <p className="text-xs text-[var(--text-tertiary)]">
          侧栏 320px · 终端 200px（仅重置尺寸）；文件在自适应弹窗中打开。
        </p>
      </div>
    </section>
  );
}
