import { useEffect } from "react";
import { toastError } from "@/stores/toast.store";

/** Consume a pending store error through the shared message popup. */
export function useErrorToast(error: string | null, message: string, clearError: () => void) {
  useEffect(() => {
    if (!error) return;
    toastError(message, error);
    clearError();
  }, [error, message, clearError]);
}
