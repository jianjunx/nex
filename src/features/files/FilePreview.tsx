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
