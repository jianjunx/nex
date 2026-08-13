import { create } from "zustand";
import { isOverComposer, resolveDirDropTarget, type Point } from "../lib/dropTargets";
import { useProjectStore } from "./project.store";

/** An in-page pointer drag session (a tree node being moved / attached). */
export interface TreeNodeDragSession {
  kind: "tree-node";
  path: string;
  name: string;
  isDir: boolean;
}

interface DragDropState {
  /** Active internal pointer-drag session (null while idle). */
  session: TreeNodeDragSession | null;
  /** Directory currently hovered as a drop target (OS drag or internal drag). */
  overDir: string | null;
  /** Whether an internal file drag hovers the composer drop zone. */
  overComposer: boolean;
  begin: (session: TreeNodeDragSession) => void;
  updateHover: (p: Point) => void;
  setOsHoverDir: (dir: string | null) => void;
  clearHover: () => void;
  finish: () => void;
}

/**
 * Transient drag/drop state kept OUT of fs.store so per-frame hover updates
 * never touch editor/tree data. TreeNode subscribes with a fine-grained
 * selector (`overDir === node.path`), so only the hovered row re-renders.
 */
export const useDragDropStore = create<DragDropState>()((set, get) => ({
  session: null,
  overDir: null,
  overComposer: false,

  begin: (session) => set({ session, overDir: null, overComposer: false }),

  updateHover: (p) => {
    const { session, overDir, overComposer } = get();
    const tree = document.querySelector("[data-file-tree]") as HTMLElement | null;
    const ps = useProjectStore.getState();
    const root = ps.projects.find((pr) => pr.id === ps.activeProjectId)?.path ?? "";
    const dir = resolveDirDropTarget(p, tree, root);
    // Folders cannot attach into the composer.
    const composer = !!session && !session.isDir && isOverComposer(p);
    if (dir !== overDir || composer !== overComposer) {
      set({ overDir: dir, overComposer: composer });
    }
  },

  setOsHoverDir: (dir) => {
    if (get().overDir !== dir) set({ overDir: dir });
  },

  clearHover: () => {
    const { overDir, overComposer } = get();
    if (overDir !== null || overComposer) set({ overDir: null, overComposer: false });
  },

  finish: () => set({ session: null, overDir: null, overComposer: false }),
}));
