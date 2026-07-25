import { GlassModal } from "../../ui";
import { useFsStore } from "../../stores/fs.store";

export function FilePreview() {
  const { previewFile, closePreview } = useFsStore();

  return (
    <GlassModal open={!!previewFile} onClose={closePreview} title={previewFile?.path.split("/").pop()}>
      {previewFile && (
        <div className="max-h-[60vh] overflow-auto px-2">
          {previewFile.isText ? (
            <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed">
              {previewFile.content}
            </pre>
          ) : (
            <p className="text-sm text-[var(--text-tertiary)] py-2">
              Binary file ({(previewFile.size / 1024).toFixed(1)} KB) — preview not available
            </p>
          )}
        </div>
      )}
    </GlassModal>
  );
}
