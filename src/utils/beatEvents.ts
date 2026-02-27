export const BEATS_UPDATED_EVENT = "sanhuoai:beats-updated";

export interface BeatsUpdatedDetail {
  chapterId?: string;
  reason?: string;
  ts: number;
}

export const emitBeatsUpdated = (chapterId?: string, reason?: string) => {
  if (typeof window === "undefined") return;
  const detail: BeatsUpdatedDetail = {
    chapterId: chapterId ? String(chapterId) : undefined,
    reason: reason ? String(reason) : undefined,
    ts: Date.now(),
  };
  window.dispatchEvent(new CustomEvent<BeatsUpdatedDetail>(BEATS_UPDATED_EVENT, { detail }));
};
