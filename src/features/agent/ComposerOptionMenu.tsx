import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ITEM_HIGHLIGHT =
  "focus:bg-[var(--overlay-hover)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[var(--overlay-hover)]";

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
          className="h-7 max-w-[12rem] shrink-0 gap-0.5 rounded-md px-1.5 text-xs font-normal text-[var(--text-secondary)] hover:bg-[var(--glass-2-surface)]"
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[10rem] max-w-[18rem] rounded-[var(--radius-md)] p-1.5"
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.id}
            onSelect={() => onSelect(o.id)}
            className={`px-3 text-xs transition-colors duration-100 ${ITEM_HIGHLIGHT} ${
              o.id === value
                ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
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
