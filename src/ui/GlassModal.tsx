import { type ReactNode } from "react";
import { Modal, ModalContent, ModalTitle } from "@glinui/ui";

interface GlassModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}

export function GlassModal({ open, onClose, children, title }: GlassModalProps) {
  return (
    <Modal open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <ModalContent variant="glass">
        {title ? (
          <ModalTitle className="mb-4 pr-8">{title}</ModalTitle>
        ) : (
          <ModalTitle className="sr-only">Dialog</ModalTitle>
        )}
        {children}
      </ModalContent>
    </Modal>
  );
}
