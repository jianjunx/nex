import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ITEM_HIGHLIGHT =
  "focus:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] data-[highlighted]:text-[var(--text-primary)]";

export interface ComposerGroupedOptionItem {
  id: string;
  /** Display name (model id without provider prefix). */
  name: string;
  /** Group key shown as a section header (provider display name). */
  group: string;
}

interface Props {
  ariaLabel: string;
  value: string;
  options: ComposerGroupedOptionItem[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** Model picker with provider section headers and separators. */
export function ComposerGroupedOptionMenu({
  ariaLabel,
  value,
  options,
  onSelect,
  disabled,
  placeholder = "—",
}: Props) {
  const current = options.find((o) => o.id === value);
  const label = current?.name ?? placeholder;

  const groups: { group: string; items: ComposerGroupedOptionItem[] }[] = [];
  for (const opt of options) {
    const g = opt.group || "其他";
    const last = groups[groups.length - 1];
    if (last && last.group === g) last.items.push(opt);
    else groups.push({ group: g, items: [opt] });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || options.length === 0}
          aria-label={ariaLabel}
          title={ariaLabel}
          className="nex-interactive-chrome nex-pressable h-7 max-w-[12rem] shrink-0 gap-1 rounded-[var(--radius-md)] border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_78%,transparent)] px-2.5 text-xs font-medium tracking-[-0.01em] text-[var(--text-secondary)] shadow-[inset_0_1px_0_0_var(--edge-highlight-soft)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_78%,transparent)] hover:text-[var(--text-primary)] data-[state=open]:bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)] data-[state=open]:text-[var(--text-primary)]"
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[11rem] max-w-[20rem] max-h-[350px] overflow-y-auto rounded-[calc(var(--radius-md)+2px)] p-1.5"
      >
        {groups.map((g, gi) => (
          <div key={g.group}>
            {gi > 0 && <DropdownMenuSeparator className="my-1" />}
            <DropdownMenuLabel className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              {g.group}
            </DropdownMenuLabel>
            {g.items.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onSelect={() => onSelect(o.id)}
                className={`px-3 text-xs nex-interactive-chrome ${ITEM_HIGHLIGHT} ${
                  o.id === value
                    ? "bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                <span className="truncate">{o.name}</span>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
