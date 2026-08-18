// File/folder icons backed by the official material-icon-theme icon set.
// Mappings and SVG assets are generated — see scripts/gen-file-icons.mjs.
import { memo } from "react";
import {
  defaultFileIcon,
  defaultFolderIcon,
  defaultFolderOpenIcon,
  defaultRootFolderIcon,
  defaultRootFolderOpenIcon,
} from "./iconManifest.generated";
import { resolveIcon } from "./resolveIcon";
import type { ResolveIconOptions } from "./resolveIcon";

const ICON_BASE = `${import.meta.env.BASE_URL}file-icons/`;

function iconUrl(iconName: string): string {
  return ICON_BASE + iconName + ".svg";
}

export function fallbackIconName(opts: ResolveIconOptions = {}): string {
  const { isFolder = false, isOpen = false, isRoot = false } = opts;
  if (!isFolder) return defaultFileIcon;
  if (isRoot) return isOpen ? defaultRootFolderOpenIcon : defaultRootFolderIcon;
  return isOpen ? defaultFolderOpenIcon : defaultFolderIcon;
}

/** Icon URL for a filename — for imperative DOM (e.g. CM6 widgets). */
export function fileIconUrl(filename: string, opts: ResolveIconOptions = {}): string {
  return iconUrl(resolveIcon(filename, opts));
}

export function fallbackFileIconUrl(opts: ResolveIconOptions = {}): string {
  return iconUrl(fallbackIconName(opts));
}

export function replaceWithFallbackIcon(
  img: { src: string; onerror: OnErrorEventHandler | null },
  opts: ResolveIconOptions = {},
): void {
  const fallback = fallbackFileIconUrl(opts);
  img.onerror = null;
  if (img.src !== fallback) img.src = fallback;
}

export type FileIconProps = {
  filename: string;
  isFolder?: boolean;
  /** Folder expanded state → renders the `-open` variant. */
  isOpen?: boolean;
  /** Project root row → dedicated root-folder icon. */
  isRoot?: boolean;
  size?: number;
  className?: string;
};

const FileIcon = memo(function FileIcon({
  filename,
  isFolder = false,
  isOpen = false,
  isRoot = false,
  size = 14,
  className,
}: FileIconProps) {
  return (
    <img
      src={fileIconUrl(filename, { isFolder, isOpen, isRoot })}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={className}
      style={{ flexShrink: 0 }}
      onError={(e) => replaceWithFallbackIcon(e.currentTarget, { isFolder, isOpen, isRoot })}
    />
  );
});

export default FileIcon;
