import { usePendingOption } from "./usePendingOption";
import type { ReactNode } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TRIGGER_BASE =
  "nex-interactive-chrome nex-pressable h-7 max-w-[12rem] shrink-0 gap-1 rounded-[var(--radius-md)] px-2.5 text-xs font-medium tracking-[-0.01em] text-[var(--text-secondary)] shadow-none hover:text-[var(--text-primary)] data-[state=open]:text-[var(--text-primary)]";
/** Inside the prompt box: no chip background, only a hover/open wash. */
const TRIGGER_PLAIN =
  "border border-transparent bg-transparent hover:bg-[var(--overlay-hover)] data-[state=open]:bg-[var(--overlay-hover)]";
/** Standalone (e.g. the new-task bar above the prompt box). */
const TRIGGER_BORDERED =
  "border border-[color:var(--hairline-soft)] bg-[color:color-mix(in_srgb,var(--material-panel)_78%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--material-floating)_78%,transparent)] data-[state=open]:bg-[color:color-mix(in_srgb,var(--material-elevated)_88%,transparent)]";

const ITEM_HIGHLIGHT =
  "focus:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] data-[highlighted]:text-[var(--text-primary)]";

export interface ComposerOptionItem {
  id: string;
  name: string;
}

/** Non-selectable footer command (e.g. "打开文件夹…"). */
export interface ComposerOptionAction {
  id: string;
  name: string;
  icon?: ReactNode;
  onSelect: () => void;
}

interface Props {
  /** Accessible name for the trigger (e.g. Mode / Model / Auth). */
  ariaLabel: string;
  value: string;
  options: ComposerOptionItem[];
  onSelect: (id: string) => void | Promise<void>;
  disabled?: boolean;
  /** Optional empty placeholder when value is blank. */
  placeholder?: string;
  /** Tooltip override; defaults to ariaLabel. */
  title?: string;
  /** Optional leading icon for the trigger and each item. */
  renderIcon?: (id: string) => ReactNode;
  actions?: ComposerOptionAction[];
  /** Draw the chip border/background (default: plain, for use inside the prompt box). */
  bordered?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ComposerOptionMenu({
  ariaLabel,
  value,
  options,
  onSelect,
  disabled,
  placeholder = "—",
  title,
  renderIcon,
  actions,
  bordered = false,
  onOpenChange,
}: Props) {
  const { open, setOpen, pendingId, select } = usePendingOption(onSelect, onOpenChange);
  const current = options.find((o) => o.id === value);
  const label = current?.name ?? placeholder;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || (options.length === 0 && !actions?.length)}
          aria-label={ariaLabel}
          title={title ?? ariaLabel}
          className={`${TRIGGER_BASE} ${bordered ? TRIGGER_BORDERED : TRIGGER_PLAIN}`}
        >
          {current && renderIcon?.(current.id)}
          <span className="truncate">{label}</span>
          {pendingId !== null ? (
            <LoaderCircle size={12} className="shrink-0 animate-spin" aria-label="切换中" />
          ) : <ChevronDown size={12} className="shrink-0 opacity-50" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[10rem] max-w-[18rem] max-h-[350px] overflow-y-auto rounded-[calc(var(--radius-md)+2px)] p-1.5"
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.id}
            disabled={disabled || pendingId !== null}
            aria-busy={pendingId === o.id}
            onSelect={(event) => {
              event.preventDefault();
              void select(o.id);
            }}
            className={`px-3 text-xs nex-interactive-chrome ${ITEM_HIGHLIGHT} ${
              o.id === value
                ? "bg-[color:color-mix(in_srgb,var(--material-elevated)_86%,transparent)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)]"
            }`}
          >
            {renderIcon?.(o.id)}
            <span className="flex-1 truncate">{o.name}</span>
            {pendingId === o.id && <LoaderCircle size={13} className="ml-auto shrink-0 animate-spin" aria-label="切换中" />}
          </DropdownMenuItem>
        ))}
        {actions && actions.length > 0 && (
          <>
            <DropdownMenuSeparator className="my-1.5" />
            {actions.map((a) => (
              <DropdownMenuItem
                key={a.id}
                disabled={disabled || pendingId !== null}
                onSelect={a.onSelect}
                className={`px-3 text-xs nex-interactive-chrome text-[var(--text-secondary)] ${ITEM_HIGHLIGHT}`}
              >
                {a.icon}
                <span className="truncate">{a.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
