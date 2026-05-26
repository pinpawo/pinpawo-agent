import AppKit

enum SettingsWindowFocus {
  static func bringToFront() {
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.async {
      settingsWindow()?.makeKeyAndOrderFront(nil)
      settingsWindow()?.orderFrontRegardless()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
      settingsWindow()?.makeKeyAndOrderFront(nil)
      settingsWindow()?.orderFrontRegardless()
    }
  }

  private static func settingsWindow() -> NSWindow? {
    NSApp.windows.first { window in
      window.identifier?.rawValue == "settings" || window.title == "设置"
    }
  }
}
