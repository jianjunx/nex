import { vi } from "vitest";

/**
 * Node 26 exposes an incomplete experimental `localStorage` unless the process
 * receives a backing-file flag. That global can leak into jsdom and replace its
 * working implementation with an object whose methods are undefined. Install a
 * deterministic per-test-file storage object before application modules load.
 */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(String(key)) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(String(key))),
    setItem: vi.fn((key: string, value: string) =>
      values.set(String(key), String(value)),
    ),
  };
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: memoryStorage(),
});

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: memoryStorage(),
});
