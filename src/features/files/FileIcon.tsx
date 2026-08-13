// File/folder icons backed by the official material-icon-theme icon set.
// Mappings and SVG assets are generated — see scripts/gen-file-icons.mjs.
import { memo } from "react";
import { resolveIcon } from "./resolveIcon";

const ICON_BASE = `${import.meta.env.BASE_URL}file-icons/`;

/** Icon URL for a filename — for imperative DOM (e.g. CM6 widgets). */
export function fileIconUrl(filename: string): string {
  return ICON_BASE + resolveIcon(filename) + ".svg";
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
      src={ICON_BASE + resolveIcon(filename, { isFolder, isOpen, isRoot }) + ".svg"}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={className}
      style={{ flexShrink: 0 }}
    />
  );
});

export default FileIcon;
