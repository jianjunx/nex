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
//! ## 红绿灯的垂直位置
//!
//! 挂上 toolbar 后标题栏容器变成 52pt 高，AppKit 把红绿灯在 52pt 里居中（中心距
//! 窗口顶 26pt）；而 tao 的 `inset_traffic_lights`（每次 `drawRect:` 都跑）又把
//! 容器高度压回 `按钮高 + tauri.conf.json 的 trafficLightPosition.y`，并且**只改
//! x 不改 y**——按钮留在 AppKit 给的 y 上，于是被提到容器顶部，比前端 TopBar 的
//! 内容中心高出一截。
//!
//! 所以这里做两件事，让红绿灯中心正好落在 TopBar（`h-11` = 44pt）的中线上：
//! 1. `tauri.conf.json` 的 `trafficLightPosition.y` 取 `44 - 按钮高`，容器高度
//!    因此等于 44，和 TopBar 一样高；
//! 2. 把每个按钮的 `origin.y` 设成 `(44 - 按钮高) / 2`，在带子里垂直居中。
//!
//! ## 跨平台
//!
//! 只有 macOS 有"系统绘制标题栏材质"这回事。Windows / Linux 上这个模块整体编译
//! 成空操作（`cfg` 门控在调用方），不会因为平台不同而报错。

/// 前端 TopBar 的高度（`TITLE_BAR_HEIGHT_CLASS = "h-11"`）。红绿灯要在这个
/// 带子里垂直居中，才能和标题、图标对齐。
#[cfg(target_os = "macos")]
const TITLE_BAR_HEIGHT: objc2_core_foundation::CGFloat = 44.0;

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

    center_traffic_lights(window);

    log::info!("[titlebar] 已启用 macOS 液态玻璃标题栏");
}

/// 把红绿灯在一条 44pt 高的带子里垂直居中，和前端 TopBar 的内容对齐。
///
/// 同时把标题栏容器高度设成 44：`inset_traffic_lights` 之后会按
/// `trafficLightPosition.y` 重设这个高度，配置里已经取 `44 - 按钮高`，两边一致；
/// 这里再设一次只是让 setup 当场看到的状态就是对的。
#[cfg(target_os = "macos")]
fn center_traffic_lights(window: &objc2_app_kit::NSWindow) {
    use objc2_app_kit::{NSView, NSWindowButton};

    let kinds = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ];
    let Some(close) = window.standardWindowButton(kinds[0]) else {
        return;
    };
    let button_height = NSView::frame(&close).size.height;

    for kind in kinds {
        let Some(button) = window.standardWindowButton(kind) else {
            continue;
        };
        // 容器视图用的是左下原点（实测 isFlipped = false），所以 origin.y 是"距容器
        // 底部的高度"，越大越靠上。容器高 44、按钮高 14，取半高差即是垂直居中。
        let mut origin = NSView::frame(&button).origin;
        origin.y = (TITLE_BAR_HEIGHT - button_height) / 2.0;
        button.setFrameOrigin(origin);
    }

    // close.superview() 是按钮容器，再上一层才是标题栏容器（tao 也是这么取的）。
    // SAFETY: superview / setFrame 都是标准 NSView 调用，且我们在主线程上。
    let container = unsafe {
        close.superview()
            .and_then(|s| s.superview())
    };
    let Some(container) = container else {
        return;
    };
    let mut rect = NSView::frame(&container);
    rect.size.height = TITLE_BAR_HEIGHT;
    rect.origin.y = window.frame().size.height - TITLE_BAR_HEIGHT;
    container.setFrame(rect);
}

/// 非 macOS 平台没有对应的系统材质，整体空操作。
#[cfg(not(target_os = "macos"))]
pub fn enable_liquid_glass_titlebar(_ns_window: *mut std::ffi::c_void) {}
