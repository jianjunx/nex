// Whether a KeyRecorder is currently waiting for a keypress. SettingsDialog
// reads this to suppress Radix's Esc-to-close while recording: the dismiss
// layer listens on document CAPTURE (before React's root handlers), so the
// recorder's own preventDefault cannot stop the dialog from closing.
let recording = false;

export function setRecordingActive(v: boolean): void {
  recording = v;
}

export function isRecordingActive(): boolean {
  return recording;
}
