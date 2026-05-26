import AppKit
import SwiftUI

@MainActor
final class DesktopPetController {
  private var window: NSPanel?
  private var dragStartOrigin: NSPoint?
  private var dragStartMouseLocation: NSPoint?
  private let size = NSSize(width: 160, height: 160)

  func show(appState: AppState, recenter: Bool = false) {
    if let window {
      if recenter {
        window.setFrameOrigin(defaultOrigin(for: window.frame.size))
      }
      window.alphaValue = 1
      window.orderFrontRegardless()
      return
    }

    let origin = defaultOrigin(for: size)
    let panel = NSPanel(
      contentRect: NSRect(origin: origin, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = false
    panel.isExcludedFromWindowsMenu = true
    panel.acceptsMouseMovedEvents = true

    panel.contentView = NSHostingView(rootView: DesktopPetView(
      appState: appState,
      onDragChanged: { [weak self] translation in self?.drag(translation: translation) },
      onDragEnded: { [weak self] in self?.endDrag() }
    ))

    window = panel
    panel.orderFrontRegardless()
  }

  func hide() {
    window?.orderOut(nil)
  }

  private func defaultOrigin(for size: NSSize) -> NSPoint {
    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    return NSPoint(
      x: screenFrame.maxX - size.width - 48,
      y: screenFrame.midY - size.height / 2
    )
  }

  private func drag(translation: CGSize) {
    guard let window else { return }
    if dragStartOrigin == nil {
      dragStartOrigin = window.frame.origin
      dragStartMouseLocation = NSEvent.mouseLocation
    }
    guard let start = dragStartOrigin, let mouseStart = dragStartMouseLocation else { return }
    let mouse = NSEvent.mouseLocation
    window.setFrameOrigin(NSPoint(
      x: start.x + mouse.x - mouseStart.x,
      y: start.y + mouse.y - mouseStart.y
    ))
  }

  private func endDrag() {
    dragStartOrigin = nil
    dragStartMouseLocation = nil
  }
}
