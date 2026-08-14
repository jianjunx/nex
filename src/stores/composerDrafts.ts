/**
 * Per-conversation composer drafts, kept OUTSIDE zustand: keystroke-frequency
 * updates must not draft the whole agent/conversation store. Cap + LRU keep
 * memory bounded under multi-project × multi-tab use.
 */

export type ComposerMention = { path: string; name: string };

/** Pending image attachment shape accepted by the composer. Image bytes are
 * intentionally not retained in cross-tab drafts. */
export type ComposerDraftImage = {
  id: string;
  mimeType: string;
  data: string;
};

export type ComposerDraft = {
  text: string;
  mentions: ComposerMention[];
  images: ComposerDraftImage[];
};

const DRAFT_MAX = 40;
const drafts = new Map<string, ComposerDraft>();
const order: string[] = [];

function touch(id: string) {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  order.push(id);
  while (order.length > DRAFT_MAX) {
    const old = order.shift();
    if (old) drafts.delete(old);
  }
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return !draft.text && draft.mentions.length === 0;
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return {
    text: draft.text,
    mentions: draft.mentions.map((m) => ({ path: m.path, name: m.name })),
    // Base64 attachments can be megabytes each. They are deliberately
    // one-shot composer input rather than long-lived draft/store state.
    images: [],
  };
}

/** Persist (or clear) text/mentions for a conversation tab. Image attachments
 * are dropped on tab switch/unmount instead of retaining base64 in memory. */
export function saveComposerDraft(conversationId: string, draft: ComposerDraft): void {
  const next = cloneDraft({
    text: draft.text,
    mentions: draft.mentions,
    images: draft.images ?? [],
  });
  if (isEmptyDraft(next)) {
    drafts.delete(conversationId);
    const i = order.indexOf(conversationId);
    if (i >= 0) order.splice(i, 1);
    return;
  }
  drafts.set(conversationId, next);
  touch(conversationId);
}

export function loadComposerDraft(conversationId: string): ComposerDraft | null {
  const d = drafts.get(conversationId);
  if (!d) return null;
  touch(conversationId);
  return cloneDraft(d);
}

export function clearComposerDraft(conversationId: string): void {
  drafts.delete(conversationId);
  const i = order.indexOf(conversationId);
  if (i >= 0) order.splice(i, 1);
}

/** Test-only: wipe module state. */
export function __resetComposerDrafts(): void {
  drafts.clear();
  order.length = 0;
}
