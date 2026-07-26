const AUTO_SAVE_MS = 1500;
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clearAutoSaveTimer(path: string) {
  const t = autoSaveTimers.get(path);
  if (t) {
    clearTimeout(t);
    autoSaveTimers.delete(path);
  }
}

export function clearAllAutoSaveTimers() {
  for (const t of autoSaveTimers.values()) {
    clearTimeout(t);
  }
  autoSaveTimers.clear();
}

export function scheduleAutoSaveTimer(path: string, onFire: () => void) {
  clearAutoSaveTimer(path);
  autoSaveTimers.set(
    path,
    setTimeout(() => {
      autoSaveTimers.delete(path);
      onFire();
    }, AUTO_SAVE_MS),
  );
}
