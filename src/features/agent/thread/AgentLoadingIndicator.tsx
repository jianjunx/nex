import { memo, useEffect, useState } from "react";
import LoadingState from "@/components/agent-ui/beautiful-ui/LoadingState";
import {
  LOADING_ROTATE_MS,
  pickLoadingPhrase,
  type LoadingContext,
} from "./loadingPhrases";

/**
 * Agent 忙碌但还没产出下一条可见内容时的等待提示。
 * 文案随上下文变化并定时轮换；读屏只读固定的"正在思考"，不随轮换反复播报。
 */
export const AgentLoadingIndicator = memo(function AgentLoadingIndicator({
  context,
}: {
  context: LoadingContext;
}) {
  // 每次等待从不同位置起步；挂载时定一次，轮换期间保持稳定。
  const [seed] = useState(() => Math.floor(Math.random() * 1000));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), LOADING_ROTATE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex max-w-[96%] items-center gap-2 text-sm text-[var(--text-tertiary)]">
      <div className="beautiful-ui">
        <LoadingState
          variant="Dots"
          label={pickLoadingPhrase(context, tick, seed)}
          statusLabel="正在思考"
        />
      </div>
    </div>
  );
});
