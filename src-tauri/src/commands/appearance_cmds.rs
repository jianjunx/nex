use crate::error::NexError;

/// Re-applies the OS window tint for the given theme ("dark" → dark glass,
/// anything else → light). The CSS theme switch is instant, but the native
/// glass tint is set by the OS compositor and must be re-issued at runtime;
/// `lib.rs` setup only applies the startup tint. Errors map to
/// `NexError::Internal` and the frontend swallows them — a failing acrylic
/// refresh (e.g. Windows 10 without the composition API) must never block
/// the CSS theme switch.
#[tauri::command]
pub fn appearance_set_theme(app: tauri::AppHandle, theme: String) -> Result<(), NexError> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        use window_vibrancy::apply_acrylic;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| NexError::Internal("main window not found".into()))?;
        // RGBA tints match lib.rs setup: light (245,246,250,180) and the
        // dark counterpart (24,25,29,200).
        let tint: (u8, u8, u8, u8) = match theme.as_str() {
            "dark" => (24, 25, 29, 200),
            _ => (245, 246, 250, 180),
        };
        apply_acrylic(&window, Some(tint)).map_err(|e| NexError::Internal(e.to_string()))?;
    }

    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        use tauri_plugin_liquid_glass::{LiquidGlassConfig, LiquidGlassExt};
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| NexError::Internal("main window not found".into()))?;
        // LiquidGlassConfig.tint_color is Option<String> (verified in the
        // crate source); dark gets a translucent near-black tint, light
        // stays untinted (None) as at startup.
        let tint_color: Option<String> = match theme.as_str() {
            "dark" => Some("#18191DCC".into()),
            _ => None,
        };
        app.liquid_glass()
            .set_effect(
                &window,
                LiquidGlassConfig { enabled: true, tint_color, ..Default::default() },
            )
            .map_err(|e| NexError::Internal(e.to_string()))?;
    }

    // Other platforms: no native glass to re-tint; the CSS theme is all.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = theme;

    Ok(())
}
