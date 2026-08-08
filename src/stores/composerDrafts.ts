/**
 * Per-conversation composer drafts, kept OUTSIDE zustand: keystroke-frequency
 * updates must not draft the whole agent/conversation store. Cap + LRU keep
 * memory bounded under multi-project × multi-tab use.
 */

export type ComposerMention = { path: string; name: string };

/** Pending image attachment (base64 payload; preview URLs are recreated on load). */
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
  return !draft.text && draft.mentions.length === 0 && draft.images.length === 0;
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return {
    text: draft.text,
    mentions: draft.mentions.map((m) => ({ path: m.path, name: m.name })),
    images: draft.images.map((img) => ({
      id: img.id,
      mimeType: img.mimeType,
      data: img.data,
    })),
  };
}

/** Persist (or clear) the draft for a conversation tab. Empty drafts are dropped. */
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
