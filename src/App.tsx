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
