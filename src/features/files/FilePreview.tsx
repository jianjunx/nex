import { Modal, ModalContent, ModalHeader, ModalTitle } from "@glinui/ui";
import { useFsStore } from "../../stores/fs.store";

export function FilePreview() {
  const { previewFile, closePreview } = useFsStore();

  return (
    <Modal open={!!previewFile} onOpenChange={(o) => { if (!o) closePreview(); }}>
      <ModalContent size="sm">
        <ModalHeader>
          <ModalTitle>{previewFile?.path.split("/").pop()}</ModalTitle>
        </ModalHeader>
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
      </ModalContent>
    </Modal>
  );
}
