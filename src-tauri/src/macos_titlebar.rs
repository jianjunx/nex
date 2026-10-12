//! macOS 液态玻璃标题栏。
//!
//! ## 为什么需要这个
//!
//! 系统只在窗口**挂着 `NSToolbar`** 时才会把标题栏（连同红绿灯那一整片）渲染成
//! macOS 26 的液态玻璃。Finder / Safari / Xcode 全都有 toolbar，玻璃就是 toolbar
//! 的背景。而 Tauri / tao 建的是裸 `NSWindow`——`tauri.conf.json` 里的
//! `titleBarStyle: "Overlay"` 只做了三件事（见 tao `window.rs`）：
//!
//! ```objc
//! ns_window.setTitlebarAppearsTransparent(true);
//! ns_window.setTitleVisibility(Hidden);
//! styleMask |= NSWindowStyleMaskFullSizeContentView;
//! ```
//!
//! 没有 toolbar、没有 `NSVisualEffectView`、没有 `NSGlassEffectView`（在 tao /
//! wry 源码里搜这三个符号，零命中）。所以标题栏是一条全透明的带子，红绿灯直接
//! 坐在 WKWebView 的像素上——没有材质，就没有玻璃。
//!
//! ## 取舍
//!
//! `NSToolbar` 横跨整个窗口宽，所以玻璃会覆盖整条标题栏，前端 TopBar 上的控件
//! 等于"压在玻璃上"。这是 macOS 26 原生应用的标准形态，代价是标题栏那层的对比度
//! 要按玻璃背景来调；如果哪天内置进真 toolbar，就要把这些控件迁进去。
//!
//! 只挂一个空 toolbar：不提供 item，AppKit 就不会往里塞任何东西，玻璃是干净的。
//!
//! ## 跨平台
//!
//! 只有 macOS 有"系统绘制标题栏材质"这回事。Windows / Linux 上这个模块整体编译
//! 成空操作（`cfg` 门控在调用方），不会因为平台不同而报错。

/// 给主窗口挂上液态玻璃标题栏。非 macOS 上为空操作。
#[cfg(target_os = "macos")]
pub fn enable_liquid_glass_titlebar(ns_window: *mut std::ffi::c_void) {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSToolbar, NSToolbarDisplayMode, NSWindow, NSWindowToolbarStyle};
    use objc2_foundation::NSString;

    // Tauri 的 setup 跑在主线程；拿不到标记说明调用时机不对，直接放弃而不是崩。
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("[titlebar] 不在主线程，跳过液态玻璃标题栏");
        return;
    };

    if ns_window.is_null() {
        log::warn!("[titlebar] ns_window 指针为空，跳过液态玻璃标题栏");
        return;
    }

    // SAFETY: Tauri 保证这个指针是当前进程主窗口的 NSWindow，且 setup 在主线程跑。
    let window: &NSWindow = unsafe { &*(ns_window.cast::<NSWindow>()) };

    // 已经挂过就别再挂：重复挂同一个 identifier 的 toolbar 会互相同步状态。
    if window.toolbar().is_some() {
        return;
    }

    let identifier = NSString::from_str("nex.main.toolbar");
    let toolbar = NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), &identifier);

    // 空 toolbar：不设 delegate、不插 item，AppKit 不会显示任何控件，
    // 只留系统自己画的那层玻璃。
    toolbar.setDisplayMode(NSToolbarDisplayMode::LabelOnly);
    toolbar.setAllowsUserCustomization(false);

    // Unified = macOS 26 的液态玻璃标题栏样式。Automatic 在链接到 26+ SDK 时
    // 也会解析成 Unified，这里显式写出来，避免依赖默认值。
    window.setToolbarStyle(NSWindowToolbarStyle::Unified);
    window.setToolbar(Some(&toolbar));

    log::info!("[titlebar] 已启用 macOS 液态玻璃标题栏");
}

/// 非 macOS 平台没有对应的系统材质，整体空操作。
#[cfg(not(target_os = "macos"))]
pub fn enable_liquid_glass_titlebar(_ns_window: *mut std::ffi::c_void) {}
