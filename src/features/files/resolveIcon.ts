import {
  extMap,
  compoundExtMap,
  fileNameMap,
  folderNameMap,
  defaultFileIcon,
  defaultFolderIcon,
  defaultFolderOpenIcon,
  defaultRootFolderIcon,
  defaultRootFolderOpenIcon,
} from "./iconManifest.generated";

/** 复合扩展名最长优先,保证 `foo.schema.json` 命中 schema.json 而非 json。 */
const COMPOUND_EXT_KEYS_LONGEST_FIRST = Object.keys(compoundExtMap).sort(
  (a, b) => b.length - a.length,
);

export interface ResolveIconOptions {
  isFolder?: boolean;
  /** 文件夹展开态 → 返回 `-open` 变体(仅对文件夹有效) */
  isOpen?: boolean;
  /** 项目根目录 → 专用根文件夹图标(仅对文件夹有效) */
  isRoot?: boolean;
}

/**
 * 解析文件/文件夹名对应的 material-icon-theme 图标名(不含路径与扩展名)。
 * 纯函数,O(1) 查表为主;复合扩展名仅在文件名含两个及以上 `.` 时做最长匹配。
 */
export function resolveIcon(filename: string, opts: ResolveIconOptions = {}): string {
  const { isFolder = false, isOpen = false, isRoot = false } = opts;
  const key = filename.toLowerCase();

  if (isFolder) {
    if (isRoot) return isOpen ? defaultRootFolderOpenIcon : defaultRootFolderIcon;
    const icon = folderNameMap[key];
    if (icon) return isOpen ? icon + "-open" : icon;
    return isOpen ? defaultFolderOpenIcon : defaultFolderIcon;
  }

  if (key) {
    if (Object.prototype.hasOwnProperty.call(fileNameMap, key)) return fileNameMap[key];
    // 复合扩展名至少需要两个点(如 foo.d.ts);单点文件名直接走单段查表。
    if (key.indexOf(".") !== key.lastIndexOf(".")) {
      for (const ext of COMPOUND_EXT_KEYS_LONGEST_FIRST) {
        if (key.endsWith("." + ext)) return compoundExtMap[ext];
      }
    }
    const dot = key.lastIndexOf(".");
    if (dot > 0) {
      const icon = extMap[key.slice(dot + 1)];
      if (icon) return icon;
    }
  }
  return defaultFileIcon;
}
