/**
 * Per-project search query chrome, kept OUTSIDE zustand so typing does not
 * immer-draft the fs store on every keystroke. Results stay in fs.store and
 * are cleared on project switch (never show another project's hits).
 */

let ownerProjectId: string | null = null;
let liveQuery = "";
const queryByProject = new Map<string, string>();

export function readSearchQuery(): string {
  return liveQuery;
}

export function writeSearchQuery(query: string): void {
  liveQuery = query;
  if (ownerProjectId) queryByProject.set(ownerProjectId, query);
}

/** Swap the live query to `projectId`'s saved value (or ""). Returns the new live query. */
export function focusSearchQueryProject(projectId: string | null): string {
  if (ownerProjectId && ownerProjectId !== projectId) {
    queryByProject.set(ownerProjectId, liveQuery);
  }
  ownerProjectId = projectId;
  liveQuery = projectId ? (queryByProject.get(projectId) ?? "") : "";
  return liveQuery;
}

/** Test-only. */
export function __resetSearchProjectQuery(): void {
  ownerProjectId = null;
  liveQuery = "";
  queryByProject.clear();
}
