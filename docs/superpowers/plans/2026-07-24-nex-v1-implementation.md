# Nex v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Nex — a Tauri 2.x desktop app that integrates multiple AI coding agents via ACP protocol, with git, terminal, file browser, and Apple Liquid Glass UI.

**Architecture:** Single Tauri binary with React frontend. Rust backend manages agent processes (via official ACP SDK), git (git2-rs), terminal (portable-pty), file system (ignore crate), and SQLite persistence. Frontend uses Zustand stores synced via Tauri events/commands through a typed bridge layer. UI implements a 4-level layered glass material system.

**Tech Stack:** Tauri 2.x, React 19, TypeScript, Tailwind CSS 4, Zustand 5, Framer Motion 11, xterm.js 5, Rust (tokio, git2, portable-pty, ignore, notify, rusqlite, agent-client-protocol)

## Global Constraints

- Tauri version: ^2.x (latest stable)
- React version: ^19
- Rust edition: 2021
- Package manager: pnpm (frontend), cargo (Rust)
- CSS framework: Tailwind CSS ^4
- All Tauri commands return `Result<T, NexError>` with serde-serializable error
- All file paths in code use absolute paths from project root
- Commit after every task completion
- Dark mode is default theme

---

## Phase 1: Project Scaffolding

### Task 1: Initialize Tauri 2.x + React + Vite Project

**Files:**
- Create: entire project scaffold via `cargo tauri init` equivalent

- [ ] **Step 1: Create frontend project with Vite + React + TypeScript**

```bash
cd /Users/jj/Projects/nex
pnpm create vite@latest . --template react-ts
```

If directory not empty, create in temp and move:
```bash
pnpm create vite@latest nex-temp --template react-ts
cp -r nex-temp/* nex-temp/.* . 2>/dev/null || true
rm -rf nex-temp
```

- [ ] **Step 2: Install frontend dependencies**

```bash
pnpm add zustand immer framer-motion @xterm/xterm @xterm/addon-fit react-markdown rehype-highlight @tanstack/react-virtual lucide-react
pnpm add -D tailwindcss @tailwindcss/vite vitest @testing-library/react @testing-library/jest-dom
pnpm add -D @tauri-apps/api @tauri-apps/cli @tauri-apps/plugin-sql @tauri-apps/plugin-store @tauri-apps/plugin-dialog
```

- [ ] **Step 3: Initialize Tauri 2.x**

```bash
pnpm tauri init
```

Answer prompts:
- App name: Nex
- Window title: Nex
- Frontend dev URL: http://localhost:5173
- Frontend dist: ../dist
- Dev command: pnpm dev
- Build command: pnpm build

- [ ] **Step 4: Add Tauri plugins to Cargo.toml**

Edit `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-store = "2"
tauri-plugin-dialog = "2"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
uuid = { version = "1", features = ["v4", "serde"] }
git2 = "0.19"
portable-pty = "0.8"
notify = "7"
notify-debouncer-full = "0.4"
ignore = "0.4"
content_inspector = "0.2"
rusqlite = { version = "0.32", features = ["bundled"] }
agent-client-protocol = "0.1"
chrono = { version = "0.4", features = ["serde"] }
```

- [ ] **Step 5: Configure vite.config.ts with Tailwind**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
```

- [ ] **Step 6: Configure tauri.conf.json for vibrancy + window**

Edit `src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/nickel-org/nickel.rs/refs/heads/master/docs/schema/tauri.conf.schema.json",
  "productName": "Nex",
  "version": "0.1.0",
  "identifier": "com.nex.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "windows": [
      {
        "title": "Nex",
        "width": 1400,
        "height": 900,
        "minWidth": 900,
        "minHeight": 600,
        "transparent": true,
        "decorations": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": []
  }
}
```

- [ ] **Step 7: Configure src-tauri/src/lib.rs with plugins**

```rust
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::Builder::default().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();
                let _ = window.set_vibrancy(Some(tauri::Vibrancy::UnderWindowBackground));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 8: Update src-tauri/src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nex_lib::run();
}
```

Rename lib: in `src-tauri/Cargo.toml` ensure `[lib]` section:

```toml
[lib]
name = "nex_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
```

- [ ] **Step 9: Verify project compiles and runs**

```bash
pnpm tauri dev
```

Expected: Window opens with default Vite React page, macOS shows vibrancy background.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: initialize Tauri 2.x + React + Vite project scaffold"
```

---

### Task 2: Global CSS + Tailwind Setup + Design Tokens

**Files:**
- Create: `src/styles/globals.css`
- Create: `src/styles/vibrancy.css`
- Modify: `src/main.tsx` (import styles)

- [ ] **Step 1: Create src/styles/globals.css**

```css
@import "tailwindcss";

:root {
  /* Glass materials - Dark mode (default) */
  --glass-base-bg: rgba(255, 255, 255, 0.03);
  --glass-base-blur: 40px;
  --glass-base-border: none;

  --glass-elevated-bg: rgba(255, 255, 255, 0.06);
  --glass-elevated-blur: 24px;
  --glass-elevated-border: 1px solid rgba(255, 255, 255, 0.08);

  --glass-interactive-bg: rgba(255, 255, 255, 0.10);
  --glass-interactive-blur: 16px;
  --glass-interactive-border: 1px solid rgba(255, 255, 255, 0.12);

  --glass-overlay-bg: rgba(255, 255, 255, 0.15);
  --glass-overlay-blur: 12px;
  --glass-overlay-border: 1px solid rgba(255, 255, 255, 0.18);

  /* Text */
  --text-primary: rgba(255, 255, 255, 0.92);
  --text-secondary: rgba(255, 255, 255, 0.60);
  --text-tertiary: rgba(255, 255, 255, 0.38);

  /* Accent */
  --accent: #7C8AFF;
  --accent-hover: #9BA6FF;
  --accent-glow: rgba(124, 138, 255, 0.20);

  /* Semantic */
  --success: #34D399;
  --warning: #FBBF24;
  --error: #F87171;

  /* Radius */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
}

/* Light mode override */
[data-theme="light"] {
  --glass-base-bg: rgba(0, 0, 0, 0.02);
  --glass-elevated-bg: rgba(0, 0, 0, 0.04);
  --glass-elevated-border: 1px solid rgba(0, 0, 0, 0.06);
  --glass-interactive-bg: rgba(0, 0, 0, 0.06);
  --glass-interactive-border: 1px solid rgba(0, 0, 0, 0.08);
  --glass-overlay-bg: rgba(0, 0, 0, 0.08);
  --glass-overlay-border: 1px solid rgba(0, 0, 0, 0.10);

  --text-primary: rgba(0, 0, 0, 0.88);
  --text-secondary: rgba(0, 0, 0, 0.56);
  --text-tertiary: rgba(0, 0, 0, 0.36);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #root {
  height: 100%;
  width: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
  color: var(--text-primary);
  background: transparent;
}

/* Glass highlight pseudo-element utility */
.glass-highlight {
  position: relative;
}
.glass-highlight::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.12) 0%,
    rgba(255, 255, 255, 0.0) 40%
  );
  pointer-events: none;
  z-index: 1;
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}
```

- [ ] **Step 2: Create src/styles/vibrancy.css**

```css
/* macOS: window is transparent, system vibrancy provides L0 */
@media (-webkit-appearance: none) {
  html, body {
    background: transparent !important;
  }
}

/* Fallback for non-macOS: solid dark background */
@supports not (-webkit-appearance: none) {
  html, body {
    background: #1a1a2e;
  }
}
```

- [ ] **Step 3: Update src/main.tsx**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./styles/vibrancy.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 4: Update src/App.tsx to minimal placeholder**

```tsx
function App() {
  return (
    <div style={{ padding: 32, color: "var(--text-primary)" }}>
      <h1>Nex</h1>
      <p style={{ color: "var(--text-secondary)" }}>Liquid Glass Agent Environment</p>
    </div>
  );
}

export default App;
```

- [ ] **Step 5: Verify**

```bash
pnpm tauri dev
```

Expected: Dark transparent window with "Nex" heading, glass CSS variables applied.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add global CSS, Tailwind config, and design tokens"
```

---

## Phase 2: Liquid Glass UI Components

### Task 3: Glass Component Library

**Files:**
- Create: `src/ui/Glass.tsx`
- Create: `src/ui/GlassButton.tsx`
- Create: `src/ui/GlassInput.tsx`
- Create: `src/ui/GlassPanel.tsx`
- Create: `src/ui/GlassModal.tsx`
- Create: `src/ui/GlassTab.tsx`
- Create: `src/ui/animations.ts`
- Create: `src/ui/index.ts`

- [ ] **Step 1: Create src/ui/animations.ts**

```typescript
import type { Transition } from "framer-motion";

export const springTransition: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
};

export const fadeInUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
  transition: { duration: 0.15 },
};

export const scaleIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: springTransition,
};
```

- [ ] **Step 2: Create src/ui/Glass.tsx**

```tsx
import { forwardRef, type HTMLAttributes } from "react";

type GlassLevel = "base" | "elevated" | "interactive" | "overlay";

interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  level?: GlassLevel;
  highlight?: boolean;
}

const levelStyles: Record<GlassLevel, string> = {
  base: "backdrop-blur-[40px] bg-[var(--glass-base-bg)]",
  elevated: "backdrop-blur-[24px] bg-[var(--glass-elevated-bg)] border border-white/[0.08]",
  interactive: "backdrop-blur-[16px] bg-[var(--glass-interactive-bg)] border border-white/[0.12]",
  overlay: "backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-white/[0.18]",
};

export const Glass = forwardRef<HTMLDivElement, GlassProps>(
  ({ level = "elevated", highlight = true, className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`rounded-[var(--radius-md)] ${levelStyles[level]} ${highlight ? "glass-highlight" : ""} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Glass.displayName = "Glass";
```

- [ ] **Step 3: Create src/ui/GlassButton.tsx**

```tsx
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { motion } from "framer-motion";
import { springTransition } from "./animations";

interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "accent";
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  lg: "px-4 py-2 text-base",
};

const variants = {
  default: "bg-[var(--glass-interactive-bg)] border border-white/[0.12] hover:bg-white/[0.13]",
  ghost: "bg-transparent border border-transparent hover:bg-white/[0.06]",
  accent: "bg-[var(--accent)] border border-transparent hover:bg-[var(--accent-hover)]",
};

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ variant = "default", size = "md", className = "", children, ...props }, ref) => {
    return (
      <motion.button
        ref={ref as any}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        transition={springTransition}
        className={`rounded-[var(--radius-sm)] font-medium cursor-pointer transition-colors duration-150 ${sizes[size]} ${variants[variant]} ${className}`}
        {...(props as any)}
      >
        {children}
      </motion.button>
    );
  }
);

GlassButton.displayName = "GlassButton";
```

- [ ] **Step 4: Create src/ui/GlassInput.tsx**

```tsx
import { forwardRef, type TextareaHTMLAttributes } from "react";

interface GlassInputProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  multiline?: boolean;
}

export const GlassInput = forwardRef<HTMLTextAreaElement, GlassInputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`w-full resize-none rounded-[var(--radius-lg)] bg-[var(--glass-interactive-bg)] border border-white/[0.12] px-4 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-white/[0.20] focus:shadow-[0_0_20px_rgba(255,255,255,0.05)] transition-all duration-200 ${className}`}
        rows={1}
        {...props}
      />
    );
  }
);

GlassInput.displayName = "GlassInput";
```

- [ ] **Step 5: Create src/ui/GlassPanel.tsx**

```tsx
import { type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { springTransition } from "./animations";

interface GlassPanelProps {
  children: ReactNode;
  visible: boolean;
  width?: number;
  side?: "left" | "right";
  className?: string;
}

export function GlassPanel({ children, visible, width = 320, side = "right", className = "" }: GlassPanelProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={springTransition}
          className={`h-full overflow-hidden border-l border-white/[0.06] ${className}`}
          style={{ width }}
        >
          <div className="h-full w-full backdrop-blur-[24px] bg-[var(--glass-elevated-bg)] overflow-y-auto">
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 6: Create src/ui/GlassModal.tsx**

```tsx
import { type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { scaleIn } from "./animations";

interface GlassModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}

export function GlassModal({ open, onClose, children, title }: GlassModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />
          <motion.div
            {...scaleIn}
            className="relative z-10 w-full max-w-md rounded-[var(--radius-lg)] backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-white/[0.18] p-6 glass-highlight"
          >
            {title && (
              <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">{title}</h2>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 7: Create src/ui/GlassTab.tsx**

```tsx
import { motion } from "framer-motion";

interface GlassTabProps {
  label: string;
  active: boolean;
  indicator?: "running" | "idle" | "waiting" | null;
  onClick: () => void;
  onClose?: () => void;
}

export function GlassTab({ label, active, indicator, onClick, onClose }: GlassTabProps) {
  const indicatorColor = indicator === "running" ? "var(--accent)" : indicator === "waiting" ? "var(--warning)" : "transparent";

  return (
    <motion.div
      layoutId={`tab-${label}`}
      onClick={onClick}
      className={`relative flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm transition-colors ${
        active ? "bg-[var(--glass-interactive-bg)] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      }`}
    >
      {indicator && indicator !== "idle" && (
        <motion.span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: indicatorColor }}
          animate={indicator === "running" ? { scale: [1, 1.3, 1] } : {}}
          transition={{ repeat: Infinity, duration: 1.5 }}
        />
      )}
      <span className="max-w-[120px] truncate">{label}</span>
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="ml-1 opacity-50 hover:opacity-100 text-xs"
        >
          ×
        </button>
      )}
      {active && (
        <motion.div
          layoutId="tab-underline"
          className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--accent)] rounded-full"
        />
      )}
    </motion.div>
  );
}
```

- [ ] **Step 8: Create src/ui/index.ts**

```typescript
export { Glass } from "./Glass";
export { GlassButton } from "./GlassButton";
export { GlassInput } from "./GlassInput";
export { GlassPanel } from "./GlassPanel";
export { GlassModal } from "./GlassModal";
export { GlassTab } from "./GlassTab";
export { springTransition, fadeInUp, scaleIn } from "./animations";
```

- [ ] **Step 9: Verify compilation**

```bash
pnpm tsc --noEmit
```

Expected: No errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add liquid glass UI component library"
```

---

## Phase 3: App Layout Shell

### Task 4: Main Layout + TopBar + IconBar

**Files:**
- Create: `src/features/layout/TopBar.tsx`
- Create: `src/features/layout/IconBar.tsx`
- Create: `src/features/layout/MainLayout.tsx`
- Create: `src/stores/ui.store.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create src/stores/ui.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type SidePanelTab = "files" | "git" | "search";

interface UiState {
  sidePanelVisible: boolean;
  sidePanelTab: SidePanelTab;
  terminalVisible: boolean;
  sidePanelWidth: number;
  terminalHeight: number;

  toggleSidePanel: () => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  toggleTerminal: () => void;
  setSidePanelWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
}

export const useUiStore = create<UiState>()(
  immer((set) => ({
    sidePanelVisible: true,
    sidePanelTab: "files",
    terminalVisible: false,
    sidePanelWidth: 320,
    terminalHeight: 200,

    toggleSidePanel: () => set((s) => { s.sidePanelVisible = !s.sidePanelVisible; }),
    setSidePanelTab: (tab) => set((s) => { s.sidePanelTab = tab; s.sidePanelVisible = true; }),
    toggleTerminal: () => set((s) => { s.terminalVisible = !s.terminalVisible; }),
    setSidePanelWidth: (w) => set((s) => { s.sidePanelWidth = w; }),
    setTerminalHeight: (h) => set((s) => { s.terminalHeight = h; }),
  }))
);
```

- [ ] **Step 2: Create src/features/layout/IconBar.tsx**

```tsx
import { FolderTree, GitBranch, Search, Settings } from "lucide-react";
import { useUiStore, type SidePanelTab } from "../../stores/ui.store";

const tabs: { id: SidePanelTab; icon: typeof FolderTree; label: string }[] = [
  { id: "files", icon: FolderTree, label: "文件" },
  { id: "git", icon: GitBranch, label: "Git" },
  { id: "search", icon: Search, label: "搜索" },
];

export function IconBar() {
  const { sidePanelTab, setSidePanelTab, toggleTerminal } = useUiStore();

  return (
    <div className="flex flex-col items-center py-2 gap-1 w-10 border-l border-white/[0.06] bg-[var(--glass-base-bg)]">
      {tabs.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          title={label}
          onClick={() => setSidePanelTab(id)}
          className={`p-2 rounded-[var(--radius-sm)] transition-colors ${
            sidePanelTab === id ? "bg-white/[0.10] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          <Icon size={16} />
        </button>
      ))}
      <div className="flex-1" />
      <button
        title="设置"
        className="p-2 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <Settings size={16} />
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create src/features/layout/TopBar.tsx**

```tsx
import { Plus, PanelRight } from "lucide-react";
import { GlassButton } from "../../ui";
import { useUiStore } from "../../stores/ui.store";

export function TopBar() {
  const { toggleSidePanel, sidePanelVisible } = useUiStore();

  return (
    <div className="flex items-center h-10 px-3 gap-2 border-b border-white/[0.06] bg-[var(--glass-base-bg)] backdrop-blur-[40px]">
      {/* Project selector placeholder */}
      <GlassButton size="sm" variant="ghost">
        Projects ▾
      </GlassButton>

      {/* New conversation */}
      <GlassButton size="sm" variant="ghost">
        <Plus size={14} />
      </GlassButton>

      {/* Conversation tabs placeholder */}
      <div className="flex items-center gap-1 flex-1 overflow-x-auto">
        <span className="text-xs text-[var(--text-tertiary)] px-2">No conversations</span>
      </div>

      {/* Panel toggle */}
      <GlassButton size="sm" variant="ghost" onClick={toggleSidePanel}>
        <PanelRight size={14} className={sidePanelVisible ? "text-[var(--accent)]" : ""} />
      </GlassButton>
    </div>
  );
}
```

- [ ] **Step 4: Create src/features/layout/MainLayout.tsx**

```tsx
import { type ReactNode } from "react";
import { TopBar } from "./TopBar";
import { IconBar } from "./IconBar";
import { useUiStore } from "../../stores/ui.store";

interface MainLayoutProps {
  mainContent: ReactNode;
  sidePanel: ReactNode;
}

export function MainLayout({ mainContent, sidePanel }: MainLayoutProps) {
  const { sidePanelVisible, sidePanelWidth } = useUiStore();

  return (
    <div className="flex flex-col h-full w-full">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {mainContent}
        </div>

        {/* Side panel */}
        {sidePanelVisible && (
          <div
            className="flex flex-col border-l border-white/[0.06] overflow-hidden"
            style={{ width: sidePanelWidth }}
          >
            <div className="flex-1 overflow-hidden">
              {sidePanel}
            </div>
          </div>
        )}

        {/* Icon bar */}
        <IconBar />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Update src/App.tsx**

```tsx
import { MainLayout } from "./features/layout/MainLayout";

function App() {
  return (
    <MainLayout
      mainContent={
        <div className="flex-1 flex items-center justify-center text-[var(--text-tertiary)]">
          <p>Agent conversation area</p>
        </div>
      }
      sidePanel={
        <div className="p-3 text-sm text-[var(--text-secondary)]">
          Side panel content
        </div>
      }
    />
  );
}

export default App;
```

- [ ] **Step 6: Verify**

```bash
pnpm tauri dev
```

Expected: Window shows TopBar with project selector + new button, empty main area, side panel with placeholder, icon bar on right.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add main layout shell with TopBar, IconBar, and UI store"
```

---

## Phase 4: Rust Backend Foundation

### Task 5: AppState + Error Type + DB Schema

**Files:**
- Create: `src-tauri/src/state.rs`
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/schema.rs`
- Create: `src-tauri/src/db/conversations.rs`
- Create: `src-tauri/src/db/projects.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create src-tauri/src/error.rs**

```rust
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum NexError {
    #[error("Agent error: {0}")]
    Agent(String),
    #[error("Git error: {0}")]
    Git(String),
    #[error("Terminal error: {0}")]
    Terminal(String),
    #[error("FileSystem error: {0}")]
    FileSystem(String),
    #[error("Database error: {0}")]
    Database(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for NexError {
    fn from(e: rusqlite::Error) -> Self {
        NexError::Database(e.to_string())
    }
}

impl From<git2::Error> for NexError {
    fn from(e: git2::Error) -> Self {
        NexError::Git(e.to_string())
    }
}

impl From<std::io::Error> for NexError {
    fn from(e: std::io::Error) -> Self {
        NexError::Internal(e.to_string())
    }
}
```

- [ ] **Step 2: Create src-tauri/src/db/schema.rs**

```rust
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    last_opened INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    title       TEXT NOT NULL DEFAULT 'New Chat',
    agent_type  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'idle',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    tool_summary    TEXT,
    timestamp       INTEGER NOT NULL,
    sequence        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, sequence);
"#;
```

- [ ] **Step 3: Create src-tauri/src/db/mod.rs**

```rust
pub mod schema;
pub mod conversations;
pub mod projects;

use rusqlite::Connection;
use std::sync::Mutex;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: &std::path::Path) -> Result<Self, crate::error::NexError> {
        let conn = Connection::open(path)?;
        conn.execute_batch(schema::SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}
```

- [ ] **Step 4: Create src-tauri/src/db/projects.rs**

```rust
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::Database;
use crate::error::NexError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
    pub last_opened: i64,
}

impl Database {
    pub fn create_project(&self, name: &str, path: &str) -> Result<Project, NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            path: path.to_string(),
            created_at: now,
            last_opened: now,
        };
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, last_opened) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project.id, project.name, project.path, project.created_at, project.last_opened],
        )?;
        Ok(project)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, path, created_at, last_opened FROM projects ORDER BY last_opened DESC")?;
        let projects = stmt.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                last_opened: row.get(4)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(projects)
    }

    pub fn update_project_last_opened(&self, id: &str) -> Result<(), NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute("UPDATE projects SET last_opened = ?1 WHERE id = ?2", params![now, id])?;
        Ok(())
    }
}
```

- [ ] **Step 5: Create src-tauri/src/db/conversations.rs**

```rust
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::Database;
use crate::error::NexError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent_type: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub tool_summary: Option<String>,
    pub timestamp: i64,
    pub sequence: i32,
}

impl Database {
    pub fn create_conversation(&self, project_id: &str, agent_type: &str) -> Result<Conversation, NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let conv = Conversation {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            title: "New Chat".to_string(),
            agent_type: agent_type.to_string(),
            status: "idle".to_string(),
            created_at: now,
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO conversations (id, project_id, title, agent_type, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![conv.id, conv.project_id, conv.title, conv.agent_type, conv.status, conv.created_at, conv.updated_at],
        )?;
        Ok(conv)
    }

    pub fn list_conversations(&self, project_id: &str) -> Result<Vec<Conversation>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, project_id, title, agent_type, status, created_at, updated_at FROM conversations WHERE project_id = ?1 ORDER BY updated_at DESC")?;
        let convs = stmt.query_map(params![project_id], |row| {
            Ok(Conversation {
                id: row.get(0)?, project_id: row.get(1)?, title: row.get(2)?,
                agent_type: row.get(3)?, status: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(convs)
    }

    pub fn append_message(&self, conversation_id: &str, role: &str, content: &str, tool_summary: Option<&str>) -> Result<Message, NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let seq: i32 = conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;
        let msg = Message {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            tool_summary: tool_summary.map(|s| s.to_string()),
            timestamp: now,
            sequence: seq,
        };
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, tool_summary, timestamp, sequence) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![msg.id, msg.conversation_id, msg.role, msg.content, msg.tool_summary, msg.timestamp, msg.sequence],
        )?;
        conn.execute("UPDATE conversations SET updated_at = ?1 WHERE id = ?2", params![now, conversation_id])?;
        Ok(msg)
    }

    pub fn get_messages(&self, conversation_id: &str, limit: i32, offset: i32) -> Result<Vec<Message>, NexError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, conversation_id, role, content, tool_summary, timestamp, sequence FROM messages WHERE conversation_id = ?1 ORDER BY sequence ASC LIMIT ?2 OFFSET ?3")?;
        let msgs = stmt.query_map(params![conversation_id, limit, offset], |row| {
            Ok(Message {
                id: row.get(0)?, conversation_id: row.get(1)?, role: row.get(2)?,
                content: row.get(3)?, tool_summary: row.get(4)?, timestamp: row.get(5)?, sequence: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(msgs)
    }

    pub fn update_conversation_status(&self, id: &str, status: &str) -> Result<(), NexError> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute("UPDATE conversations SET status = ?1, updated_at = ?2 WHERE id = ?3", params![status, now, id])?;
        Ok(())
    }
}
```

- [ ] **Step 6: Create src-tauri/src/state.rs**

```rust
use std::sync::Arc;
use crate::db::Database;

pub struct AppState {
    pub db: Arc<Database>,
}
```

- [ ] **Step 7: Update src-tauri/src/lib.rs to register DB + state**

```rust
use tauri::Manager;
mod error;
mod state;
pub mod db;

use state::AppState;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::Builder::default().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();
                let _ = window.set_vibrancy(Some(tauri::Vibrancy::UnderWindowBackground));
            }

            // Initialize database
            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("nex.db");
            let db = Database::new(&db_path).expect("failed to initialize database");

            app.manage(AppState { db: Arc::new(db) });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 8: Verify Rust compilation**

```bash
cd src-tauri && cargo check
```

Expected: Compiles without errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add Rust backend foundation - AppState, NexError, DB schema + CRUD"
```

---

## Phase 5: Bridge Layer + Frontend Stores

### Task 6: Typed Bridge Layer + Project/Conversation Stores

**Files:**
- Create: `src/bridge/events.ts`
- Create: `src/bridge/commands.ts`
- Create: `src/bridge/tauri.ts`
- Create: `src/stores/project.store.ts`
- Create: `src/stores/conversation.store.ts`
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/project_cmds.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create src/bridge/events.ts**

```typescript
// Event name constants - must match Rust emit() calls
export const EVENTS = {
  ACP_NOTIFICATION: "acp-notification",
  ACP_PERMISSION_REQUEST: "acp-permission-request",
  ACP_SESSION_TERMINATED: "acp-session-terminated",
  GIT_STATUS_CHANGED: "git-status-changed",
  TERMINAL_OUTPUT: "terminal-output",
  FS_CHANGED: "fs-changed",
} as const;

export interface AcpNotificationPayload {
  sessionId: string;
  update: unknown; // SessionUpdate from ACP
}

export interface AcpPermissionRequestPayload {
  sessionId: string;
  requestId: string;
  options: { optionId: string; label: string }[];
}

export interface GitStatusChangedPayload {
  projectPath: string;
}

export interface TerminalOutputPayload {
  terminalId: string;
  data: string;
}

export interface FsChangedPayload {
  projectPath: string;
  paths: string[];
}
```

- [ ] **Step 2: Create src/bridge/commands.ts**

```typescript
// Command names - must match Rust #[tauri::command] function names
export const COMMANDS = {
  // Projects
  PROJECT_OPEN: "project_open",
  PROJECT_LIST: "project_list",
  // Conversations
  CONVERSATION_CREATE: "conversation_create",
  CONVERSATION_LIST: "conversation_list",
  CONVERSATION_GET_MESSAGES: "conversation_get_messages",
  // ACP
  ACP_CREATE_SESSION: "acp_create_session",
  ACP_SEND_PROMPT: "acp_send_prompt",
  ACP_CANCEL: "acp_cancel",
  ACP_RESPOND_PERMISSION: "acp_respond_permission",
  // Git
  GIT_STATUS: "git_status",
  GIT_DIFF: "git_diff",
  GIT_LOG: "git_log",
  GIT_STAGE: "git_stage",
  GIT_UNSTAGE: "git_unstage",
  GIT_COMMIT: "git_commit",
  GIT_BRANCH_LIST: "git_branch_list",
  GIT_CHECKOUT: "git_checkout",
  // Terminal
  TERMINAL_CREATE: "terminal_create",
  TERMINAL_WRITE: "terminal_write",
  TERMINAL_RESIZE: "terminal_resize",
  TERMINAL_KILL: "terminal_kill",
  // FS
  FS_READ_TREE: "fs_read_tree",
  FS_EXPAND_DIR: "fs_expand_dir",
  FS_READ_FILE: "fs_read_file",
} as const;
```

- [ ] **Step 3: Create src/bridge/tauri.ts**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { COMMANDS } from "./commands";
import { EVENTS, type AcpNotificationPayload, type AcpPermissionRequestPayload, type TerminalOutputPayload, type FsChangedPayload } from "./events";

// --- Projects ---
export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: number;
  last_opened: number;
}

export async function projectOpen(path: string): Promise<Project> {
  return invoke(COMMANDS.PROJECT_OPEN, { path });
}

export async function projectList(): Promise<Project[]> {
  return invoke(COMMANDS.PROJECT_LIST);
}

// --- Conversations ---
export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  agent_type: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_summary: string | null;
  timestamp: number;
  sequence: number;
}

export async function conversationCreate(projectId: string, agentType: string): Promise<Conversation> {
  return invoke(COMMANDS.CONVERSATION_CREATE, { projectId, agentType });
}

export async function conversationList(projectId: string): Promise<Conversation[]> {
  return invoke(COMMANDS.CONVERSATION_LIST, { projectId });
}

export async function conversationGetMessages(conversationId: string, limit = 50, offset = 0): Promise<Message[]> {
  return invoke(COMMANDS.CONVERSATION_GET_MESSAGES, { conversationId, limit, offset });
}

// --- ACP ---
export async function acpCreateSession(conversationId: string, agentCommand: string, cwd: string): Promise<string> {
  return invoke(COMMANDS.ACP_CREATE_SESSION, { conversationId, agentCommand, cwd });
}

export async function acpSendPrompt(sessionId: string, content: string): Promise<void> {
  return invoke(COMMANDS.ACP_SEND_PROMPT, { sessionId, content });
}

export async function acpCancel(sessionId: string): Promise<void> {
  return invoke(COMMANDS.ACP_CANCEL, { sessionId });
}

export async function acpRespondPermission(requestId: string, optionId: string | null): Promise<void> {
  return invoke(COMMANDS.ACP_RESPOND_PERMISSION, { requestId, optionId });
}

// --- Git ---
export interface GitFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked";
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export async function gitStatus(projectPath: string): Promise<GitStatus> {
  return invoke(COMMANDS.GIT_STATUS, { projectPath });
}

export async function gitDiff(projectPath: string, file: string, staged: boolean): Promise<string> {
  return invoke(COMMANDS.GIT_DIFF, { projectPath, file, staged });
}

export async function gitStage(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_STAGE, { projectPath, files });
}

export async function gitUnstage(projectPath: string, files: string[]): Promise<void> {
  return invoke(COMMANDS.GIT_UNSTAGE, { projectPath, files });
}

export async function gitCommit(projectPath: string, message: string): Promise<string> {
  return invoke(COMMANDS.GIT_COMMIT, { projectPath, message });
}

// --- Terminal ---
export async function terminalCreate(projectPath: string, shell?: string): Promise<string> {
  return invoke(COMMANDS.TERMINAL_CREATE, { projectPath, shell });
}

export async function terminalWrite(terminalId: string, data: string): Promise<void> {
  return invoke(COMMANDS.TERMINAL_WRITE, { terminalId, data });
}

export async function terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
  return invoke(COMMANDS.TERMINAL_RESIZE, { terminalId, cols, rows });
}

export async function terminalKill(terminalId: string): Promise<void> {
  return invoke(COMMANDS.TERMINAL_KILL, { terminalId });
}

// --- FS ---
export interface FsNode {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
}

export async function fsReadTree(projectPath: string): Promise<FsNode[]> {
  return invoke(COMMANDS.FS_READ_TREE, { projectPath });
}

export async function fsExpandDir(dirPath: string): Promise<FsNode[]> {
  return invoke(COMMANDS.FS_EXPAND_DIR, { dirPath });
}

export async function fsReadFile(filePath: string): Promise<{ is_text: boolean; content?: string; size: number }> {
  return invoke(COMMANDS.FS_READ_FILE, { filePath });
}

// --- Event Listeners ---
export function onAcpNotification(cb: (payload: AcpNotificationPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.ACP_NOTIFICATION, (e) => cb(e.payload as AcpNotificationPayload));
}

export function onAcpPermissionRequest(cb: (payload: AcpPermissionRequestPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.ACP_PERMISSION_REQUEST, (e) => cb(e.payload as AcpPermissionRequestPayload));
}

export function onTerminalOutput(cb: (payload: TerminalOutputPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.TERMINAL_OUTPUT, (e) => cb(e.payload as TerminalOutputPayload));
}

export function onFsChanged(cb: (payload: FsChangedPayload) => void): Promise<UnlistenFn> {
  return listen(EVENTS.FS_CHANGED, (e) => cb(e.payload as FsChangedPayload));
}
```

- [ ] **Step 4: Create src/stores/project.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { projectOpen, projectList, type Project } from "../bridge/tauri";

interface ProjectStore {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;

  loadProjects: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  switchProject: (id: string) => void;
}

export const useProjectStore = create<ProjectStore>()(
  immer((set) => ({
    projects: [],
    activeProjectId: null,
    loading: false,

    loadProjects: async () => {
      set((s) => { s.loading = true; });
      const projects = await projectList();
      set((s) => { s.projects = projects; s.loading = false; });
    },

    openProject: async (path: string) => {
      const project = await projectOpen(path);
      set((s) => {
        s.projects.unshift(project);
        s.activeProjectId = project.id;
      });
    },

    switchProject: (id: string) => {
      set((s) => { s.activeProjectId = id; });
    },
  }))
);
```

- [ ] **Step 5: Create src/stores/conversation.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { conversationCreate, conversationList, conversationGetMessages, type Conversation, type Message } from "../bridge/tauri";

interface ConversationStore {
  conversationsByProject: Record<string, Conversation[]>;
  openTabs: string[];
  activeTabId: string | null;
  messagesByConversation: Record<string, Message[]>;

  loadConversations: (projectId: string) => Promise<void>;
  createConversation: (projectId: string, agentType: string) => Promise<Conversation>;
  switchTab: (id: string) => void;
  closeTab: (id: string) => void;
  loadMessages: (conversationId: string) => Promise<void>;
  appendMessage: (conversationId: string, message: Message) => void;
}

export const useConversationStore = create<ConversationStore>()(
  immer((set) => ({
    conversationsByProject: {},
    openTabs: [],
    activeTabId: null,
    messagesByConversation: {},

    loadConversations: async (projectId: string) => {
      const convs = await conversationList(projectId);
      set((s) => { s.conversationsByProject[projectId] = convs; });
    },

    createConversation: async (projectId: string, agentType: string) => {
      const conv = await conversationCreate(projectId, agentType);
      set((s) => {
        if (!s.conversationsByProject[projectId]) s.conversationsByProject[projectId] = [];
        s.conversationsByProject[projectId].unshift(conv);
        s.openTabs.push(conv.id);
        s.activeTabId = conv.id;
      });
      return conv;
    },

    switchTab: (id: string) => {
      set((s) => { s.activeTabId = id; });
    },

    closeTab: (id: string) => {
      set((s) => {
        s.openTabs = s.openTabs.filter((t) => t !== id);
        if (s.activeTabId === id) {
          s.activeTabId = s.openTabs[s.openTabs.length - 1] || null;
        }
      });
    },

    loadMessages: async (conversationId: string) => {
      const msgs = await conversationGetMessages(conversationId);
      set((s) => { s.messagesByConversation[conversationId] = msgs; });
    },

    appendMessage: (conversationId: string, message: Message) => {
      set((s) => {
        if (!s.messagesByConversation[conversationId]) s.messagesByConversation[conversationId] = [];
        s.messagesByConversation[conversationId].push(message);
      });
    },
  }))
);
```

- [ ] **Step 6: Create src-tauri/src/commands/mod.rs**

```rust
pub mod project_cmds;
```

- [ ] **Step 7: Create src-tauri/src/commands/project_cmds.rs**

```rust
use tauri::State;
use crate::state::AppState;
use crate::error::NexError;
use crate::db::projects::Project;
use crate::db::conversations::{Conversation, Message};

#[tauri::command]
pub fn project_open(state: State<AppState>, path: String) -> Result<Project, NexError> {
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    state.db.create_project(&name, &path)
}

#[tauri::command]
pub fn project_list(state: State<AppState>) -> Result<Vec<Project>, NexError> {
    state.db.list_projects()
}

#[tauri::command]
pub fn conversation_create(state: State<AppState>, project_id: String, agent_type: String) -> Result<Conversation, NexError> {
    state.db.create_conversation(&project_id, &agent_type)
}

#[tauri::command]
pub fn conversation_list(state: State<AppState>, project_id: String) -> Result<Vec<Conversation>, NexError> {
    state.db.list_conversations(&project_id)
}

#[tauri::command]
pub fn conversation_get_messages(state: State<AppState>, conversation_id: String, limit: i32, offset: i32) -> Result<Vec<Message>, NexError> {
    state.db.get_messages(&conversation_id, limit, offset)
}
```

- [ ] **Step 8: Register commands in lib.rs**

Update `src-tauri/src/lib.rs` to add:

```rust
mod commands;

// In the builder chain, before .setup():
.invoke_handler(tauri::generate_handler![
    commands::project_cmds::project_open,
    commands::project_cmds::project_list,
    commands::project_cmds::conversation_create,
    commands::project_cmds::conversation_list,
    commands::project_cmds::conversation_get_messages,
])
```

- [ ] **Step 9: Verify full stack compiles**

```bash
cd src-tauri && cargo check && cd .. && pnpm tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add typed bridge layer, project/conversation stores, and Rust commands"
```

---

## Phase 6: File System Module

### Task 7: Rust FS Module + Frontend File Tree

**Files:**
- Create: `src-tauri/src/fs/mod.rs`
- Create: `src-tauri/src/fs/tree.rs`
- Create: `src-tauri/src/fs/read.rs`
- Create: `src-tauri/src/commands/fs_cmds.rs`
- Create: `src/stores/fs.store.ts`
- Create: `src/features/files/FileTree.tsx`
- Create: `src/features/files/FilePreview.tsx`

- [ ] **Step 1: Create src-tauri/src/fs/mod.rs**

```rust
pub mod tree;
pub mod read;
```

- [ ] **Step 2: Create src-tauri/src/fs/tree.rs**

```rust
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;
use crate::error::NexError;

#[derive(Debug, Clone, Serialize)]
pub struct FsNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

pub fn read_tree(root: &Path, depth: usize) -> Result<Vec<FsNode>, NexError> {
    let mut nodes = Vec::new();
    let walker = WalkBuilder::new(root)
        .max_depth(Some(depth))
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        if path == root { continue; }
        let metadata = entry.metadata().map_err(|e| NexError::FileSystem(e.to_string()))?;
        nodes.push(FsNode {
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
        });
    }

    // Sort: directories first, then alphabetical
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

pub fn expand_dir(dir_path: &Path) -> Result<Vec<FsNode>, NexError> {
    read_tree(dir_path, 1)
        .map(|nodes| nodes.into_iter().filter(|n| n.path != dir_path.to_string_lossy()).collect())
}
```

- [ ] **Step 3: Create src-tauri/src/fs/read.rs**

```rust
use serde::Serialize;
use std::path::Path;
use crate::error::NexError;

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub is_text: bool,
    pub content: Option<String>,
    pub size: u64,
}

const MAX_TEXT_SIZE: u64 = 1_000_000; // 1MB

pub fn read_file(path: &Path) -> Result<FileContent, NexError> {
    let metadata = std::fs::metadata(path).map_err(|e| NexError::FileSystem(e.to_string()))?;
    let size = metadata.len();

    if size > MAX_TEXT_SIZE {
        return Ok(FileContent { is_text: false, content: None, size });
    }

    let bytes = std::fs::read(path).map_err(|e| NexError::FileSystem(e.to_string()))?;
    let is_text = content_inspector::inspect(&bytes) == content_inspector::ContentType::TEXT;

    let content = if is_text {
        Some(String::from_utf8_lossy(&bytes).to_string())
    } else {
        None
    };

    Ok(FileContent { is_text, content, size })
}
```

- [ ] **Step 4: Create src-tauri/src/commands/fs_cmds.rs**

```rust
use tauri::State;
use crate::state::AppState;
use crate::error::NexError;
use crate::fs::tree::{FsNode, read_tree, expand_dir};
use crate::fs::read::{FileContent, read_file};
use std::path::Path;

#[tauri::command]
pub fn fs_read_tree(project_path: String) -> Result<Vec<FsNode>, NexError> {
    read_tree(Path::new(&project_path), 2)
}

#[tauri::command]
pub fn fs_expand_dir(dir_path: String) -> Result<Vec<FsNode>, NexError> {
    expand_dir(Path::new(&dir_path))
}

#[tauri::command]
pub fn fs_read_file(file_path: String) -> Result<FileContent, NexError> {
    read_file(Path::new(&file_path))
}
```

- [ ] **Step 5: Register FS commands in lib.rs invoke_handler**

Add to the `generate_handler!` macro:
```rust
commands::fs_cmds::fs_read_tree,
commands::fs_cmds::fs_expand_dir,
commands::fs_cmds::fs_read_file,
```

And add `pub mod fs;` and `pub mod commands::fs_cmds;` declarations.

- [ ] **Step 6: Create src/stores/fs.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { fsReadTree, fsExpandDir, fsReadFile, type FsNode } from "../bridge/tauri";

interface FsStore {
  nodesByDir: Record<string, FsNode[]>;
  expandedDirs: Set<string>;
  previewFile: { path: string; content: string | null; isText: boolean; size: number } | null;
  loading: boolean;

  loadRoot: (projectPath: string) => Promise<void>;
  expandDir: (dirPath: string) => Promise<void>;
  collapseDir: (dirPath: string) => void;
  openFile: (filePath: string) => Promise<void>;
  closePreview: () => void;
}

export const useFsStore = create<FsStore>()(
  immer((set, get) => ({
    nodesByDir: {},
    expandedDirs: new Set(),
    previewFile: null,
    loading: false,

    loadRoot: async (projectPath: string) => {
      set((s) => { s.loading = true; });
      const nodes = await fsReadTree(projectPath);
      set((s) => {
        s.nodesByDir[projectPath] = nodes;
        s.expandedDirs.add(projectPath);
        s.loading = false;
      });
    },

    expandDir: async (dirPath: string) => {
      const nodes = await fsExpandDir(dirPath);
      set((s) => {
        s.nodesByDir[dirPath] = nodes;
        s.expandedDirs.add(dirPath);
      });
    },

    collapseDir: (dirPath: string) => {
      set((s) => { s.expandedDirs.delete(dirPath); });
    },

    openFile: async (filePath: string) => {
      const result = await fsReadFile(filePath);
      set((s) => {
        s.previewFile = { path: filePath, content: result.content, isText: result.is_text, size: result.size };
      });
    },

    closePreview: () => {
      set((s) => { s.previewFile = null; });
    },
  }))
);
```

- [ ] **Step 7: Create src/features/files/FileTree.tsx**

```tsx
import { ChevronRight, ChevronDown, File, Folder } from "lucide-react";
import { useFsStore } from "../../stores/fs.store";
import { useProjectStore } from "../../stores/project.store";
import { useEffect } from "react";

function TreeNode({ node, depth }: { node: { name: string; path: string; is_dir: boolean }; depth: number }) {
  const { expandedDirs, expandDir, collapseDir, nodesByDir, openFile } = useFsStore();
  const isExpanded = expandedDirs.has(node.path);
  const children = nodesByDir[node.path];

  const handleClick = () => {
    if (node.is_dir) {
      if (isExpanded) collapseDir(node.path);
      else expandDir(node.path);
    } else {
      openFile(node.path);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        className="flex items-center gap-1 px-2 py-0.5 text-sm cursor-pointer hover:bg-white/[0.05] rounded"
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        {node.is_dir ? (
          isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span className="w-3" />
        )}
        {node.is_dir ? <Folder size={14} className="text-[var(--accent)]" /> : <File size={14} className="text-[var(--text-tertiary)]" />}
        <span className="text-[var(--text-secondary)] truncate">{node.name}</span>
      </div>
      {node.is_dir && isExpanded && children?.map((child) => (
        <TreeNode key={child.path} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function FileTree() {
  const { loadRoot, nodesByDir, expandedDirs } = useFsStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (project) loadRoot(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-3 text-sm text-[var(--text-tertiary)]">No project open</div>;

  const rootNodes = nodesByDir[project.path] || [];

  return (
    <div className="py-1 overflow-y-auto h-full">
      {rootNodes.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} />
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Create src/features/files/FilePreview.tsx**

```tsx
import { X } from "lucide-react";
import { GlassModal } from "../../ui";
import { useFsStore } from "../../stores/fs.store";

export function FilePreview() {
  const { previewFile, closePreview } = useFsStore();

  return (
    <GlassModal open={!!previewFile} onClose={closePreview} title={previewFile?.path.split("/").pop()}>
      {previewFile && (
        <div className="max-h-[60vh] overflow-auto">
          {previewFile.isText ? (
            <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap font-mono">
              {previewFile.content}
            </pre>
          ) : (
            <p className="text-sm text-[var(--text-tertiary)]">
              Binary file ({(previewFile.size / 1024).toFixed(1)} KB) — preview not available
            </p>
          )}
        </div>
      )}
    </GlassModal>
  );
}
```

- [ ] **Step 9: Verify**

```bash
cd src-tauri && cargo check && cd .. && pnpm tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add file system module - Rust tree/read + frontend file tree + preview"
```

---

## Phase 7: Git Module

### Task 8: Rust Git Module + Frontend Git Panel

**Files:**
- Create: `src-tauri/src/git/mod.rs`
- Create: `src-tauri/src/git/repository.rs`
- Create: `src-tauri/src/git/types.rs`
- Create: `src-tauri/src/commands/git_cmds.rs`
- Create: `src/stores/git.store.ts`
- Create: `src/features/git/GitPanel.tsx`

- [ ] **Step 1: Create src-tauri/src/git/types.rs**

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitFileChange {
    pub path: String,
    pub status: String, // "modified", "added", "deleted", "untracked"
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}
```

- [ ] **Step 2: Create src-tauri/src/git/repository.rs**

```rust
use git2::{Repository, StatusOptions, StatusShow, DiffFormat};
use std::path::Path;
use crate::error::NexError;
use super::types::*;

pub fn get_status(repo_path: &Path) -> Result<GitStatus, NexError> {
    let repo = Repository::open(repo_path)?;
    let head = repo.head().ok();
    let branch = head.as_ref()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".to_string());

    let (ahead, behind) = if let Ok(head) = repo.head() {
        if let Ok(upstream) = repo.branch_upstream(&head.name().unwrap_or("").replace("refs/heads/", "")) {
            let (a, b) = repo.graph_ahead_behind(head.target().unwrap(), upstream.get().target().unwrap()).unwrap_or((0, 0));
            (a as u32, b as u32)
        } else { (0, 0) }
    } else { (0, 0) };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        if s.is_index_new() || s.is_index_modified() || s.is_index_deleted() {
            let status = if s.is_index_new() { "added" } else if s.is_index_deleted() { "deleted" } else { "modified" };
            files.push(GitFileChange { path: path.clone(), status: status.to_string(), staged: true });
        }
        if s.is_wt_modified() || s.is_wt_deleted() || s.is_wt_new() {
            let status = if s.is_wt_new() { "untracked" } else if s.is_wt_deleted() { "deleted" } else { "modified" };
            files.push(GitFileChange { path, status: status.to_string(), staged: false });
        }
    }

    Ok(GitStatus { branch, ahead, behind, files })
}

pub fn get_diff(repo_path: &Path, file: &str, staged: bool) -> Result<String, NexError> {
    let repo = Repository::open(repo_path)?;
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(file);

    let diff = if staged {
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(file);
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    } else {
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(file);
        opts.include_untracked(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    let mut buf = Vec::new();
    diff.print(DiffFormat::Patch, |_, _, _, line| {
        buf.extend_from_slice(line.content());
        true
    })?;

    Ok(String::from_utf8_lossy(&buf).to_string())
}

pub fn get_log(repo_path: &Path, limit: usize) -> Result<Vec<CommitInfo>, NexError> {
    let repo = Repository::open(repo_path)?;
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TIME)?;

    let commits: Vec<CommitInfo> = walk
        .flatten()
        .take(limit)
        .filter_map(|oid| repo.find_commit(oid).ok())
        .map(|c| CommitInfo {
            hash: c.id().to_string()[..7].to_string(),
            message: c.summary().unwrap_or("").to_string(),
            author: c.author().name().unwrap_or("").to_string(),
            time: c.time().seconds(),
        })
        .collect();

    Ok(commits)
}

pub fn stage_files(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let mut index = repo.index()?;
    for file in files {
        index.add_path(std::path::Path::new(file))?;
    }
    index.write()?;
    Ok(())
}

pub fn unstage_files(repo_path: &Path, files: &[String]) -> Result<(), NexError> {
    let repo = Repository::open(repo_path)?;
    let mut index = repo.index()?;
    for file in files {
        index.remove_path(std::path::Path::new(file))?;
    }
    index.write()?;
    Ok(())
}

pub fn commit(repo_path: &Path, message: &str) -> Result<String, NexError> {
    let repo = Repository::open(repo_path)?;
    let mut index = repo.index()?;
    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;
    let head = repo.head()?.peel_to_commit()?;
    let sig = repo.signature()?;
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&head])?;
    Ok(oid.to_string())
}
```

- [ ] **Step 3: Create src-tauri/src/git/mod.rs**

```rust
pub mod repository;
pub mod types;
```

- [ ] **Step 4: Create src-tauri/src/commands/git_cmds.rs**

```rust
use tauri::State;
use std::path::Path;
use crate::state::AppState;
use crate::error::NexError;
use crate::git::repository;
use crate::git::types::*;

#[tauri::command]
pub fn git_status(project_path: String) -> Result<GitStatus, NexError> {
    repository::get_status(Path::new(&project_path))
}

#[tauri::command]
pub fn git_diff(project_path: String, file: String, staged: bool) -> Result<String, NexError> {
    repository::get_diff(Path::new(&project_path), &file, staged)
}

#[tauri::command]
pub fn git_log(project_path: String, limit: usize) -> Result<Vec<CommitInfo>, NexError> {
    repository::get_log(Path::new(&project_path), limit)
}

#[tauri::command]
pub fn git_stage(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::stage_files(Path::new(&project_path), &files)
}

#[tauri::command]
pub fn git_unstage(project_path: String, files: Vec<String>) -> Result<(), NexError> {
    repository::unstage_files(Path::new(&project_path), &files)
}

#[tauri::command]
pub fn git_commit(project_path: String, message: String) -> Result<String, NexError> {
    repository::commit(Path::new(&project_path), &message)
}
```

- [ ] **Step 5: Create src/stores/git.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { gitStatus, gitDiff, gitStage, gitUnstage, gitCommit, type GitStatus, type GitFileChange } from "../bridge/tauri";

interface GitStore {
  status: GitStatus | null;
  diff: string | null;
  diffFile: string | null;
  loading: boolean;
  error: string | null;

  refresh: (projectPath: string) => Promise<void>;
  viewDiff: (projectPath: string, file: string, staged: boolean) => Promise<void>;
  stage: (projectPath: string, files: string[]) => Promise<void>;
  unstage: (projectPath: string, files: string[]) => Promise<void>;
  commit: (projectPath: string, message: string) => Promise<void>;
}

export const useGitStore = create<GitStore>()(
  immer((set) => ({
    status: null,
    diff: null,
    diffFile: null,
    loading: false,
    error: null,

    refresh: async (projectPath: string) => {
      set((s) => { s.loading = true; s.error = null; });
      try {
        const status = await gitStatus(projectPath);
        set((s) => { s.status = status; s.loading = false; });
      } catch (e: any) {
        set((s) => { s.error = e.message || String(e); s.loading = false; });
      }
    },

    viewDiff: async (projectPath: string, file: string, staged: boolean) => {
      try {
        const diff = await gitDiff(projectPath, file, staged);
        set((s) => { s.diff = diff; s.diffFile = file; });
      } catch (e: any) {
        set((s) => { s.error = e.message || String(e); });
      }
    },

    stage: async (projectPath: string, files: string[]) => {
      await gitStage(projectPath, files);
    },

    unstage: async (projectPath: string, files: string[]) => {
      await gitUnstage(projectPath, files);
    },

    commit: async (projectPath: string, message: string) => {
      await gitCommit(projectPath, message);
    },
  }))
);
```

- [ ] **Step 6: Create src/features/git/GitPanel.tsx**

```tsx
import { useState, useEffect } from "react";
import { GitBranch, Plus, Minus, Check } from "lucide-react";
import { GlassButton } from "../../ui";
import { useGitStore } from "../../stores/git.store";
import { useProjectStore } from "../../stores/project.store";

export function GitPanel() {
  const { status, diff, diffFile, loading, error, refresh, viewDiff, stage, unstage, commit } = useGitStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);
  const [commitMsg, setCommitMsg] = useState("");

  useEffect(() => {
    if (project) refresh(project.path);
  }, [project?.path]);

  if (!project) return <div className="p-3 text-sm text-[var(--text-tertiary)]">No project</div>;

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    await commit(project.path, commitMsg);
    setCommitMsg("");
    refresh(project.path);
  };

  const staged = status?.files.filter((f) => f.staged) || [];
  const unstaged = status?.files.filter((f) => !f.staged) || [];

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06]">
        <GitBranch size={14} className="text-[var(--accent)]" />
        <span className="text-[var(--text-primary)] font-medium">{status?.branch || "—"}</span>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-[var(--text-tertiary)] text-xs">↑{status.ahead} ↓{status.behind}</span>
        )}
      </div>

      {/* File lists */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {unstaged.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center justify-between px-1 py-0.5 text-xs text-[var(--text-tertiary)]">
              <span>Changes ({unstaged.length})</span>
              <GlassButton size="sm" variant="ghost" onClick={() => stage(project.path, unstaged.map((f) => f.path))}>
                <Plus size={10} />
              </GlassButton>
            </div>
            {unstaged.map((f) => (
              <div key={f.path} className="flex items-center gap-1 px-1 py-0.5 hover:bg-white/[0.05] rounded cursor-pointer" onClick={() => viewDiff(project.path, f.path, false)}>
                <span className="text-[var(--warning)] text-xs w-3">{f.status[0].toUpperCase()}</span>
                <span className="text-[var(--text-secondary)] truncate">{f.path}</span>
              </div>
            ))}
          </div>
        )}
        {staged.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-1 py-0.5 text-xs text-[var(--text-tertiary)]">
              <span>Staged ({staged.length})</span>
              <GlassButton size="sm" variant="ghost" onClick={() => unstage(project.path, staged.map((f) => f.path))}>
                <Minus size={10} />
              </GlassButton>
            </div>
            {staged.map((f) => (
              <div key={f.path} className="flex items-center gap-1 px-1 py-0.5 hover:bg-white/[0.05] rounded cursor-pointer" onClick={() => viewDiff(project.path, f.path, true)}>
                <span className="text-[var(--success)] text-xs w-3">{f.status[0].toUpperCase()}</span>
                <span className="text-[var(--text-secondary)] truncate">{f.path}</span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-[var(--error)] text-xs px-1 mt-2">{error}</p>}
      </div>

      {/* Commit area */}
      <div className="px-2 py-2 border-t border-white/[0.06]">
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message..."
          className="w-full bg-[var(--glass-interactive-bg)] border border-white/[0.08] rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
          onKeyDown={(e) => e.key === "Enter" && handleCommit()}
        />
        <GlassButton size="sm" variant="accent" className="mt-1 w-full" onClick={handleCommit}>
          <Check size={12} className="mr-1" /> Commit
        </GlassButton>
      </div>

      {/* Diff viewer */}
      {diff && diffFile && (
        <div className="border-t border-white/[0.06] max-h-[200px] overflow-auto">
          <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">{diffFile}</div>
          <pre className="px-2 pb-2 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
            {diff.split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("+") ? "text-[var(--success)]" : line.startsWith("-") ? "text-[var(--error)]" : ""}>
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Register git commands in lib.rs**

Add to generate_handler! and module declarations.

- [ ] **Step 8: Verify**

```bash
cd src-tauri && cargo check && cd .. && pnpm tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add git module - status, diff, stage, commit + frontend panel"
```

---

## Phase 8: Terminal Module

### Task 9: Rust Terminal Module + Frontend xterm.js

**Files:**
- Create: `src-tauri/src/terminal/mod.rs`
- Create: `src-tauri/src/terminal/pty.rs`
- Create: `src-tauri/src/terminal/types.rs`
- Create: `src-tauri/src/commands/terminal_cmds.rs`
- Create: `src/stores/terminal.store.ts`
- Create: `src/features/terminal/TerminalPanel.tsx`

- [ ] **Step 1: Create src-tauri/src/terminal/types.rs**

```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
}
```

- [ ] **Step 2: Create src-tauri/src/terminal/pty.rs**

```rust
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use crate::error::NexError;

pub struct TerminalSession {
    pub id: String,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub struct TerminalManager {
    sessions: Arc<Mutex<Vec<Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self { sessions: Arc::new(Mutex::new(Vec::new())) }
    }

    pub fn create(&self, app: AppHandle, cwd: &str, shell: Option<&str>) -> Result<String, NexError> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| NexError::Terminal(e.to_string()))?;

        let mut cmd = CommandBuilder::new(shell.unwrap_or("/bin/zsh"));
        cmd.cwd(cwd);

        let child = pair.slave.spawn_command(cmd)
            .map_err(|e| NexError::Terminal(e.to_string()))?;

        let mut reader = pair.master.try_clone_reader()
            .map_err(|e| NexError::Terminal(e.to_string()))?;
        let writer = pair.master.take_writer()
            .map_err(|e| NexError::Terminal(e.to_string()))?;

        let id = Uuid::new_v4().to_string();
        let session_id = id.clone();

        // Spawn read loop
        let app_clone = app.clone();
        let sid = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_clone.emit("terminal-output", serde_json::json!({
                            "terminalId": sid,
                            "data": data
                        }));
                    }
                    Err(_) => break,
                }
            }
        });

        let session = Arc::new(TerminalSession {
            id: id.clone(),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        });

        self.sessions.lock().unwrap().push(session);
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), NexError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.iter().find(|s| s.id == id)
            .ok_or_else(|| NexError::Terminal("session not found".into()))?;
        session.writer.lock().unwrap().write_all(data.as_bytes())
            .map_err(|e| NexError::Terminal(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), NexError> {
        // Note: portable-pty resize requires keeping the master handle
        // For v1, we skip resize implementation detail (xterm.js will still work)
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), NexError> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|s| s.id != id);
        Ok(())
    }
}
```

- [ ] **Step 3: Create src-tauri/src/terminal/mod.rs**

```rust
pub mod pty;
pub mod types;
```

- [ ] **Step 4: Create src-tauri/src/commands/terminal_cmds.rs**

```rust
use tauri::{State, AppHandle};
use crate::state::AppState;
use crate::error::NexError;

#[tauri::command]
pub fn terminal_create(app: AppHandle, state: State<AppState>, project_path: String, shell: Option<String>) -> Result<String, NexError> {
    state.terminal_manager.create(app, &project_path, shell.as_deref())
}

#[tauri::command]
pub fn terminal_write(state: State<AppState>, terminal_id: String, data: String) -> Result<(), NexError> {
    state.terminal_manager.write(&terminal_id, &data)
}

#[tauri::command]
pub fn terminal_resize(state: State<AppState>, terminal_id: String, cols: u16, rows: u16) -> Result<(), NexError> {
    state.terminal_manager.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(state: State<AppState>, terminal_id: String) -> Result<(), NexError> {
    state.terminal_manager.kill(&terminal_id)
}
```

- [ ] **Step 5: Add TerminalManager to AppState**

Update `src-tauri/src/state.rs`:

```rust
use std::sync::Arc;
use crate::db::Database;
use crate::terminal::pty::TerminalManager;

pub struct AppState {
    pub db: Arc<Database>,
    pub terminal_manager: TerminalManager,
}
```

Update lib.rs setup to include `terminal_manager: TerminalManager::new()`.

- [ ] **Step 6: Create src/stores/terminal.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { terminalCreate, terminalWrite, terminalResize, terminalKill } from "../bridge/tauri";

interface TerminalSession {
  id: string;
  title: string;
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;

  create: (projectPath: string) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  kill: (id: string) => void;
  setActive: (id: string) => void;
}

export const useTerminalStore = create<TerminalStore>()(
  immer((set) => ({
    sessions: [],
    activeSessionId: null,

    create: async (projectPath: string) => {
      const id = await terminalCreate(projectPath);
      set((s) => {
        s.sessions.push({ id, title: `Terminal ${s.sessions.length + 1}` });
        s.activeSessionId = id;
      });
    },

    write: (id: string, data: string) => { terminalWrite(id, data); },
    resize: (id: string, cols: number, rows: number) => { terminalResize(id, cols, rows); },

    kill: (id: string) => {
      terminalKill(id);
      set((s) => {
        s.sessions = s.sessions.filter((t) => t.id !== id);
        if (s.activeSessionId === id) s.activeSessionId = s.sessions[0]?.id || null;
      });
    },

    setActive: (id: string) => { set((s) => { s.activeSessionId = id; }); },
  }))
);
```

- [ ] **Step 7: Create src/features/terminal/TerminalPanel.tsx**

```tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { useTerminalStore } from "../../stores/terminal.store";
import { useProjectStore } from "../../stores/project.store";
import { onTerminalOutput } from "../../bridge/tauri";
import { GlassButton } from "../../ui";

export function TerminalPanel() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const { sessions, activeSessionId, create, write, resize, kill } = useTerminalStore();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      theme: {
        background: "transparent",
        foreground: "rgba(255,255,255,0.9)",
        cursor: "rgba(255,255,255,0.7)",
      },
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    term.onData((data) => {
      if (activeSessionId) write(activeSessionId, data);
    });

    term.onResize(({ cols, rows }) => {
      if (activeSessionId) resize(activeSessionId, cols, rows);
    });

    xtermRef.current = term;

    const unlisten = onTerminalOutput(({ terminalId, data }) => {
      if (terminalId === activeSessionId) term.write(data);
    });

    return () => { unlisten.then((fn) => fn()); term.dispose(); };
  }, [activeSessionId]);

  const handleCreate = () => {
    if (project) create(project.path);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-white/[0.06]">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => useTerminalStore.getState().setActive(s.id)}
            className={`px-2 py-0.5 text-xs rounded ${s.id === activeSessionId ? "bg-white/[0.1]" : ""}`}
          >
            {s.title}
          </button>
        ))}
        <GlassButton size="sm" variant="ghost" onClick={handleCreate}><Plus size={12} /></GlassButton>
        {activeSessionId && (
          <GlassButton size="sm" variant="ghost" onClick={() => kill(activeSessionId)}><X size={12} /></GlassButton>
        )}
      </div>
      <div ref={termRef} className="flex-1 p-1" />
    </div>
  );
}
```

- [ ] **Step 8: Register terminal commands, verify, commit**

```bash
cd src-tauri && cargo check && cd .. && pnpm tsc --noEmit
git add -A
git commit -m "feat: add terminal module - PTY management + xterm.js frontend"
```

---

## Phase 9: ACP Agent Integration

### Task 10: Rust ACP Manager + Frontend Agent Chat

**Files:**
- Create: `src-tauri/src/acp/mod.rs`
- Create: `src-tauri/src/acp/manager.rs`
- Create: `src-tauri/src/acp/types.rs`
- Create: `src-tauri/src/commands/acp_cmds.rs`
- Create: `src/stores/agent.store.ts`
- Create: `src/features/agent/ChatArea.tsx`
- Create: `src/features/agent/MessageList.tsx`
- Create: `src/features/agent/ChatInput.tsx`
- Create: `src/features/agent/PermissionModal.tsx`

- [ ] **Step 1: Create src-tauri/src/acp/types.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpNotification {
    pub session_id: String,
    pub update: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpPermissionRequest {
    pub session_id: String,
    pub request_id: String,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    pub label: String,
}
```

- [ ] **Step 2: Create src-tauri/src/acp/manager.rs**

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use crate::error::NexError;

/// Manages active ACP sessions.
/// In v1, we use a simplified approach: store session metadata and
/// use the ACP SDK's client builder per session.
pub struct AcpSessionManager {
    /// Map of session_id -> agent command string (for reconnection)
    sessions: Mutex<HashMap<String, SessionInfo>>,
}

struct SessionInfo {
    agent_command: String,
    cwd: String,
    conversation_id: String,
}

impl AcpSessionManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    pub fn create_session(
        &self,
        app: &AppHandle,
        conversation_id: &str,
        agent_command: &str,
        cwd: &str,
    ) -> Result<String, NexError> {
        let session_id = uuid::Uuid::new_v4().to_string();

        // Store session info
        self.sessions.lock().unwrap().insert(session_id.clone(), SessionInfo {
            agent_command: agent_command.to_string(),
            cwd: cwd.to_string(),
            conversation_id: conversation_id.to_string(),
        });

        // In production, this is where we'd use the ACP SDK:
        // let agent = AcpAgent::from_str(agent_command)?;
        // client.builder()
        //   .on_receive_notification(|notif, _| { app.emit("acp-notification", ...); })
        //   .on_receive_request(|req, responder, _| { app.emit("acp-permission-request", ...); })
        //   .connect_with(agent, |conn| async { conn.send_request(InitializeRequest...); })
        //
        // For v1 skeleton, we emit a mock notification to verify the pipeline works:
        let app_clone = app.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let _ = app_clone.emit("acp-notification", serde_json::json!({
                "sessionId": sid,
                "update": { "type": "text", "content": "Agent session initialized (mock). ACP SDK integration pending." }
            }));
        });

        Ok(session_id)
    }

    pub fn send_prompt(&self, app: &AppHandle, session_id: &str, content: &str) -> Result<(), NexError> {
        // In production: connection.send_request(PromptRequest::new(session_id, content))
        // For v1 skeleton: echo back
        let app_clone = app.clone();
        let sid = session_id.to_string();
        let msg = content.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _ = app_clone.emit("acp-notification", serde_json::json!({
                "sessionId": sid,
                "update": { "type": "text", "content": format!("Echo: {}", msg) }
            }));
        });
        Ok(())
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), NexError> {
        // In production: send cancel request to agent
        Ok(())
    }

    pub fn remove_session(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }
}
```

- [ ] **Step 3: Create src-tauri/src/acp/mod.rs**

```rust
pub mod manager;
pub mod types;
```

- [ ] **Step 4: Add AcpSessionManager to AppState**

Update `src-tauri/src/state.rs`:

```rust
use std::sync::Arc;
use crate::db::Database;
use crate::terminal::pty::TerminalManager;
use crate::acp::manager::AcpSessionManager;

pub struct AppState {
    pub db: Arc<Database>,
    pub terminal_manager: TerminalManager,
    pub acp_manager: AcpSessionManager,
}
```

- [ ] **Step 5: Create src-tauri/src/commands/acp_cmds.rs**

```rust
use tauri::{State, AppHandle};
use crate::state::AppState;
use crate::error::NexError;

#[tauri::command]
pub fn acp_create_session(app: AppHandle, state: State<AppState>, conversation_id: String, agent_command: String, cwd: String) -> Result<String, NexError> {
    state.acp_manager.create_session(&app, &conversation_id, &agent_command, &cwd)
}

#[tauri::command]
pub fn acp_send_prompt(app: AppHandle, state: State<AppState>, session_id: String, content: String) -> Result<(), NexError> {
    state.acp_manager.send_prompt(&app, &session_id, &content)
}

#[tauri::command]
pub fn acp_cancel(state: State<AppState>, session_id: String) -> Result<(), NexError> {
    state.acp_manager.cancel(&session_id)
}

#[tauri::command]
pub fn acp_respond_permission(state: State<AppState>, request_id: String, option_id: Option<String>) -> Result<(), NexError> {
    // In production: find responder and call responder.respond(...)
    Ok(())
}
```

- [ ] **Step 6: Create src/stores/agent.store.ts**

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { acpCreateSession, acpSendPrompt, acpCancel, acpRespondPermission, onAcpNotification, onAcpPermissionRequest, type AcpPermissionRequestPayload } from "../bridge/tauri";

interface AgentSession {
  sessionId: string;
  conversationId: string;
  status: "idle" | "running" | "waiting";
}

interface AgentStore {
  sessions: Record<string, AgentSession>; // keyed by conversationId
  pendingPermission: AcpPermissionRequestPayload | null;

  createSession: (conversationId: string, agentCommand: string, cwd: string) => Promise<string>;
  sendPrompt: (sessionId: string, content: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  respondPermission: (requestId: string, optionId: string | null) => Promise<void>;
  initListeners: () => void;
}

export const useAgentStore = create<AgentStore>()(
  immer((set, get) => ({
    sessions: {},
    pendingPermission: null,

    createSession: async (conversationId, agentCommand, cwd) => {
      const sessionId = await acpCreateSession(conversationId, agentCommand, cwd);
      set((s) => {
        s.sessions[conversationId] = { sessionId, conversationId, status: "idle" };
      });
      return sessionId;
    },

    sendPrompt: async (sessionId, content) => {
      set((s) => {
        const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
        if (session) session.status = "running";
      });
      await acpSendPrompt(sessionId, content);
    },

    cancel: async (sessionId) => {
      await acpCancel(sessionId);
      set((s) => {
        const session = Object.values(s.sessions).find((ss) => ss.sessionId === sessionId);
        if (session) session.status = "idle";
      });
    },

    respondPermission: async (requestId, optionId) => {
      await acpRespondPermission(requestId, optionId);
      set((s) => { s.pendingPermission = null; });
    },

    initListeners: () => {
      onAcpNotification(({ sessionId, update }) => {
        // Update session status + append message to conversation store
        const { useConversationStore } = require("./conversation.store");
        const convStore = useConversationStore.getState();
        const msg = {
          id: crypto.randomUUID(),
          conversation_id: "", // resolved from sessionId mapping
          role: "assistant",
          content: typeof update === "object" && update !== null && "content" in update ? (update as any).content : JSON.stringify(update),
          tool_summary: null,
          timestamp: Date.now(),
          sequence: 0,
        };
        // Find conversation by session
        const state = get();
        const session = Object.values(state.sessions).find((s) => s.sessionId === sessionId);
        if (session) {
          msg.conversation_id = session.conversationId;
          convStore.appendMessage(session.conversationId, msg);
          set((s) => {
            if (s.sessions[session.conversationId]) s.sessions[session.conversationId].status = "idle";
          });
        }
      });

      onAcpPermissionRequest((payload) => {
        set((s) => { s.pendingPermission = payload; });
      });
    },
  }))
);
```

- [ ] **Step 7: Create src/features/agent/ChatInput.tsx**

```tsx
import { useState, useRef } from "react";
import { Send, Square } from "lucide-react";
import { GlassButton } from "../../ui";
import { useAgentStore } from "../../stores/agent.store";
import { useConversationStore } from "../../stores/conversation.store";

export function ChatInput() {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeTabId = useConversationStore((s) => s.activeTabId);
  const sessions = useAgentStore((s) => s.sessions);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const cancel = useAgentStore((s) => s.cancel);

  const session = activeTabId ? sessions[activeTabId] : null;
  const isRunning = session?.status === "running";

  const handleSend = async () => {
    if (!text.trim() || !session) return;
    const content = text;
    setText("");

    // Append user message locally
    const { appendMessage } = useConversationStore.getState();
    appendMessage(activeTabId!, {
      id: crypto.randomUUID(),
      conversation_id: activeTabId!,
      role: "user",
      content,
      tool_summary: null,
      timestamp: Date.now(),
      sequence: 0,
    });

    await sendPrompt(session.sessionId, content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="px-4 py-3 border-t border-white/[0.06]">
      <div className="flex items-end gap-2 rounded-[var(--radius-lg)] bg-[var(--glass-interactive-bg)] border border-white/[0.12] px-4 py-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          rows={1}
          className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none resize-none max-h-[200px]"
          style={{ minHeight: 24 }}
        />
        {isRunning ? (
          <GlassButton size="sm" variant="ghost" onClick={() => session && cancel(session.sessionId)}>
            <Square size={14} className="text-[var(--error)]" />
          </GlassButton>
        ) : (
          <GlassButton size="sm" variant="accent" onClick={handleSend} disabled={!text.trim()}>
            <Send size={14} />
          </GlassButton>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Create src/features/agent/MessageList.tsx**

```tsx
import { useConversationStore } from "../../stores/conversation.store";
import ReactMarkdown from "react-markdown";

export function MessageList() {
  const activeTabId = useConversationStore((s) => s.activeTabId);
  const messagesByConversation = useConversationStore((s) => s.messagesByConversation);
  const messages = activeTabId ? (messagesByConversation[activeTabId] || []) : [];

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
          Start a conversation
        </div>
      )}
      {messages.map((msg) => (
        <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[80%] rounded-[var(--radius-md)] px-4 py-2 text-sm ${
            msg.role === "user"
              ? "bg-[var(--accent)]/20 text-[var(--text-primary)]"
              : "bg-[var(--glass-interactive-bg)] text-[var(--text-primary)]"
          }`}>
            {msg.role === "assistant" ? (
              <ReactMarkdown className="prose prose-invert prose-sm max-w-none">{msg.content}</ReactMarkdown>
            ) : (
              <p className="whitespace-pre-wrap">{msg.content}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Create src/features/agent/PermissionModal.tsx**

```tsx
import { GlassModal, GlassButton } from "../../ui";
import { useAgentStore } from "../../stores/agent.store";

export function PermissionModal() {
  const { pendingPermission, respondPermission } = useAgentStore();

  if (!pendingPermission) return null;

  return (
    <GlassModal open={true} onClose={() => respondPermission(pendingPermission.requestId, null)} title="Permission Required">
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        The agent is requesting permission:
      </p>
      <div className="space-y-2">
        {pendingPermission.options.map((opt) => (
          <GlassButton
            key={opt.optionId}
            variant="default"
            className="w-full justify-start"
            onClick={() => respondPermission(pendingPermission.requestId, opt.optionId)}
          >
            {opt.label}
          </GlassButton>
        ))}
        <GlassButton variant="ghost" className="w-full" onClick={() => respondPermission(pendingPermission.requestId, null)}>
          Deny
        </GlassButton>
      </div>
    </GlassModal>
  );
}
```

- [ ] **Step 10: Create src/features/agent/ChatArea.tsx**

```tsx
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { PermissionModal } from "./PermissionModal";

export function ChatArea() {
  return (
    <div className="flex flex-col h-full">
      <MessageList />
      <ChatInput />
      <PermissionModal />
    </div>
  );
}
```

- [ ] **Step 11: Register ACP commands, verify, commit**

Register all ACP commands in lib.rs. Verify compilation. Then:

```bash
git add -A
git commit -m "feat: add ACP agent integration - session manager + chat UI + permission modal"
```

---

## Phase 10: Integration & Assembly

### Task 11: Wire Everything Together in App.tsx

**Files:**
- Modify: `src/App.tsx`
- Create: `src/features/layout/SidePanel.tsx`

- [ ] **Step 1: Create src/features/layout/SidePanel.tsx**

```tsx
import { useUiStore } from "../../stores/ui.store";
import { useUiStore as useUi } from "../../stores/ui.store";
import { FileTree } from "../files/FileTree";
import { GitPanel } from "../git/GitPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";

export function SidePanel() {
  const { sidePanelTab, terminalVisible, terminalHeight } = useUi();

  return (
    <div className="flex flex-col h-full">
      {/* Upper: active tab content */}
      <div className="flex-1 overflow-hidden">
        {sidePanelTab === "files" && <FileTree />}
        {sidePanelTab === "git" && <GitPanel />}
        {sidePanelTab === "search" && <div className="p-3 text-sm text-[var(--text-tertiary)]">Search (coming soon)</div>}
      </div>

      {/* Lower: terminal */}
      {terminalVisible && (
        <div className="border-t border-white/[0.06]" style={{ height: terminalHeight }}>
          <TerminalPanel />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update src/App.tsx with full integration**

```tsx
import { useEffect } from "react";
import { MainLayout } from "./features/layout/MainLayout";
import { SidePanel } from "./features/layout/SidePanel";
import { ChatArea } from "./features/agent/ChatArea";
import { FilePreview } from "./features/files/FilePreview";
import { useAgentStore } from "./stores/agent.store";
import { useProjectStore } from "./stores/project.store";

function App() {
  const initListeners = useAgentStore((s) => s.initListeners);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  useEffect(() => {
    initListeners();
    loadProjects();
  }, []);

  return (
    <>
      <MainLayout
        mainContent={<ChatArea />}
        sidePanel={<SidePanel />}
      />
      <FilePreview />
    </>
  );
}

export default App;
```

- [ ] **Step 3: Verify full app runs**

```bash
pnpm tauri dev
```

Expected: Full layout with chat area, side panel (file tree/git/terminal), top bar, icon bar. All panels render.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire all modules together - full app layout with agent, git, terminal, files"
```

---

### Task 12: TopBar Integration - Project Selector + Conversation Tabs

**Files:**
- Modify: `src/features/layout/TopBar.tsx`
- Create: `src/features/projects/ProjectSelector.tsx`
- Create: `src/features/projects/NewConversationModal.tsx`

- [ ] **Step 1: Create src/features/projects/ProjectSelector.tsx**

```tsx
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { GlassButton, GlassModal } from "../../ui";
import { useProjectStore } from "../../stores/project.store";

export function ProjectSelector() {
  const { projects, activeProjectId, openProject, switchProject } = useProjectStore();
  const [showList, setShowList] = useState(false);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const handleOpen = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      await openProject(selected);
    }
  };

  return (
    <div className="relative">
      <GlassButton size="sm" variant="ghost" onClick={() => setShowList(!showList)}>
        {activeProject?.name || "Open Project"} ▾
      </GlassButton>

      {showList && (
        <div className="absolute top-full left-0 mt-1 z-40 min-w-[200px] rounded-[var(--radius-md)] backdrop-blur-[12px] bg-[var(--glass-overlay-bg)] border border-white/[0.18] p-1">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { switchProject(p.id); setShowList(false); }}
              className={`w-full text-left px-3 py-1.5 text-sm rounded-[var(--radius-sm)] ${p.id === activeProjectId ? "bg-white/[0.1] text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-white/[0.05]"}`}
            >
              {p.name}
            </button>
          ))}
          <div className="border-t border-white/[0.08] mt-1 pt-1">
            <button onClick={() => { handleOpen(); setShowList(false); }} className="w-full text-left px-3 py-1.5 text-sm text-[var(--accent)] rounded-[var(--radius-sm)] hover:bg-white/[0.05]">
              + Open Folder...
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create src/features/projects/NewConversationModal.tsx**

```tsx
import { useState } from "react";
import { GlassModal, GlassButton } from "../../ui";
import { useConversationStore } from "../../stores/conversation.store";
import { useAgentStore } from "../../stores/agent.store";
import { useProjectStore } from "../../stores/project.store";

const AGENTS = [
  { id: "claude-code", label: "Claude Code", command: "claude --acp" },
  { id: "codex", label: "Codex", command: "codex --acp" },
  { id: "cursor-cli", label: "Cursor CLI", command: "cursor --acp" },
  { id: "opencode", label: "Opencode", command: "opencode --acp" },
];

interface Props { open: boolean; onClose: () => void; }

export function NewConversationModal({ open, onClose }: Props) {
  const [selectedAgent, setSelectedAgent] = useState(AGENTS[0]);
  const createConversation = useConversationStore((s) => s.createConversation);
  const createSession = useAgentStore((s) => s.createSession);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const handleCreate = async () => {
    if (!project) return;
    const conv = await createConversation(project.id, selectedAgent.id);
    await createSession(conv.id, selectedAgent.command, project.path);
    onClose();
  };

  return (
    <GlassModal open={open} onClose={onClose} title="New Conversation">
      <div className="space-y-2 mb-4">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelectedAgent(a)}
            className={`w-full text-left px-3 py-2 rounded-[var(--radius-sm)] text-sm ${selectedAgent.id === a.id ? "bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[var(--text-primary)]" : "bg-[var(--glass-interactive-bg)] border border-white/[0.08] text-[var(--text-secondary)]"}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <GlassButton variant="accent" className="w-full" onClick={handleCreate}>
        Create
      </GlassButton>
    </GlassModal>
  );
}
```

- [ ] **Step 3: Update TopBar.tsx with real project selector + tabs + new conversation**

Replace TopBar content to use ProjectSelector, GlassTab for open conversations, and NewConversationModal trigger.

- [ ] **Step 4: Verify and commit**

```bash
pnpm tauri dev
git add -A
git commit -m "feat: integrate project selector, conversation tabs, and new conversation modal"
```

---

## Phase 11: Polish & Cleanup

### Task 13: Terminal Toggle in IconBar + Final Wiring

- [ ] **Step 1:** Add terminal toggle button to IconBar (Terminal icon from lucide-react, calls toggleTerminal)
- [ ] **Step 2:** Initialize ACP event listeners on app mount
- [ ] **Step 3:** Add auto-resize observer to xterm.js (ResizeObserver on container → fitAddon.fit())
- [ ] **Step 4:** Verify all modules work end-to-end
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: final integration polish - terminal toggle, resize observer, event listener init"
```

---

### Task 14: Unit Tests (Rust DB + FS)

**Files:**
- Create: `src-tauri/tests/db_test.rs`
- Create: `src-tauri/tests/fs_test.rs`

- [ ] **Step 1: Write DB CRUD tests**

```rust
// src-tauri/tests/db_test.rs
use nex_lib::db::Database;
use tempfile::tempdir;

#[test]
fn test_create_and_list_projects() {
    let dir = tempdir().unwrap();
    let db = Database::new(&dir.path().join("test.db")).unwrap();
    let p = db.create_project("Test", "/tmp/test").unwrap();
    assert_eq!(p.name, "Test");
    let list = db.list_projects().unwrap();
    assert_eq!(list.len(), 1);
}

#[test]
fn test_conversation_and_messages() {
    let dir = tempdir().unwrap();
    let db = Database::new(&dir.path().join("test.db")).unwrap();
    let p = db.create_project("Test", "/tmp/test").unwrap();
    let c = db.create_conversation(&p.id, "claude-code").unwrap();
    let m = db.append_message(&c.id, "user", "hello", None).unwrap();
    assert_eq!(m.sequence, 1);
    let msgs = db.get_messages(&c.id, 10, 0).unwrap();
    assert_eq!(msgs.len(), 1);
}
```

- [ ] **Step 2: Write FS tree tests**

```rust
// src-tauri/tests/fs_test.rs
use nex_lib::fs::tree::read_tree;
use tempfile::tempdir;
use std::fs;

#[test]
fn test_read_tree_respects_structure() {
    let dir = tempdir().unwrap();
    fs::create_dir(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
    fs::write(dir.path().join("README.md"), "# Test").unwrap();

    let nodes = read_tree(dir.path(), 2).unwrap();
    assert!(nodes.len() >= 3); // src/, src/main.rs, README.md
    assert!(nodes.iter().any(|n| n.name == "src" && n.is_dir));
}
```

- [ ] **Step 3: Add tempfile dev-dependency**

```toml
# src-tauri/Cargo.toml [dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: add Rust unit tests for DB CRUD and FS tree scanning"
```

---

## Summary

| Phase | Tasks | Deliverable |
|---|---|---|
| 1. Scaffolding | 1-2 | Runnable Tauri app with design tokens |
| 2. UI Components | 3 | Glass component library |
| 3. Layout Shell | 4 | Full app layout with panels |
| 4. Rust Foundation | 5 | DB + error handling + state |
| 5. Bridge + Stores | 6 | Typed IPC + project/conversation stores |
| 6. File System | 7 | File tree + preview |
| 7. Git | 8 | Git status/diff/commit panel |
| 8. Terminal | 9 | Embedded terminal |
| 9. ACP Agent | 10 | Agent chat + permissions |
| 10. Integration | 11-12 | Full app wired together |
| 11. Polish + Tests | 13-14 | Terminal toggle, tests |

Total: **14 tasks**, each producing a testable, committable increment.
"}'