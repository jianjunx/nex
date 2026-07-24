import { GlassButton, GlassModal } from "../../ui";
import { useAgentStore } from "../../stores/agent.store";

export function PermissionModal() {
  const pendingPermission = useAgentStore((s) => s.pendingPermission);
  const respondPermission = useAgentStore((s) => s.respondPermission);

  if (!pendingPermission) return null;

  const dismiss = () => void respondPermission(pendingPermission.requestId, null);

  return (
    <GlassModal open={true} onClose={dismiss} title="Permission Required">
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        The agent is requesting permission:
      </p>
      <div className="space-y-2">
        {pendingPermission.options.map((opt) => (
          <GlassButton
            key={opt.optionId}
            variant="default"
            className="w-full justify-start"
            onClick={() => void respondPermission(pendingPermission.requestId, opt.optionId)}
          >
            {opt.label}
          </GlassButton>
        ))}
        <GlassButton variant="ghost" className="w-full" onClick={dismiss}>
          Deny
        </GlassButton>
      </div>
    </GlassModal>
  );
}
