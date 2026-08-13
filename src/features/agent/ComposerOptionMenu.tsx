import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ITEM_HIGHLIGHT =
  "focus:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] data-[highlighted]:text-[var(--text-primary)]";

export interface ComposerOptionItem {
  id: string;
  name: string;
}

interface Props {
  /** Accessible name for the trigger (e.g. Mode / Model / Auth). */
  ariaLabel: string;
  value: string;
  options: ComposerOptionItem[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  /** Optional empty placeholder when value is blank. */
  placeholder?: string;
}

export function ComposerOptionMenu({
  ariaLabel,
  value,
  options,
  onSelect,
  disabled,
  placeholder = "—",
}: Props) {
  const current = options.find((o) => o.id === value);
  const label = current?.name ?? placeholder;

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
        className="min-w-[10rem] max-w-[18rem] max-h-[350px] overflow-y-auto rounded-[calc(var(--radius-md)+2px)] p-1.5"
      >
        {options.map((o) => (
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
