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
  "focus:bg-[var(--overlay-hover)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[var(--overlay-hover)]";

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
          className="h-7 max-w-[12rem] shrink-0 gap-0.5 rounded-md px-0.5 text-xs font-normal text-[var(--text-secondary)] hover:bg-[var(--glass-2-surface)]"
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[11rem] max-w-[20rem] max-h-[350px] overflow-y-auto rounded-[var(--radius-md)] p-1.5"
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
                className={`px-3 text-xs transition-colors duration-100 ${ITEM_HIGHLIGHT} ${
                  o.id === value
                    ? "bg-[var(--overlay-active)] text-[var(--text-primary)]"
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
