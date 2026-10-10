import { ApprovalPromptCard } from "@/components/agent-ui/beautiful-ui/ApprovalCard";

/** Inline or dialog permission prompt, using the Approval Card option rows. */
export function PermissionApproval({
  title,
  detail,
  note,
  options,
  onRespond,
}: {
  title: string;
  detail?: string | null;
  note?: string | null;
  options: { optionId: string; label: string }[];
  onRespond: (optionId: string | null) => void;
}) {
  return (
    <ApprovalPromptCard
      sections={[
        {
          id: "permission",
          prompt: title,
          type: "radio",
          options: options.map((opt) => ({ id: opt.optionId, label: opt.label })),
          selectedIds: [],
          pending: true,
          onToggle: (optionId) => onRespond(optionId),
        },
      ]}
      detail={detail}
      note={note}
      skipLabel="拒绝"
      onSkip={() => onRespond(null)}
    />
  );
}
