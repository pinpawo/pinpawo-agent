import AppKit
import SwiftUI

struct AnimatedGIFView: NSViewRepresentable {
  let name: String
  let animates: Bool

  func makeNSView(context: Context) -> NSImageView {
    let imageView = NSImageView()
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.canDrawSubviewsIntoLayer = true
    imageView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    imageView.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    return imageView
  }

  func updateNSView(_ imageView: NSImageView, context: Context) {
    if context.coordinator.currentName != name {
      context.coordinator.currentName = name
      imageView.image = loadImage(name: name)
    }
    imageView.animates = animates
  }

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  // TODO: DesktopPet currently loads the sheep animation pack. Keep this
  // in sync with the app by resolving variants through per-pet animation packs.
  private func loadImage(name: String) -> NSImage? {
    if let url = Bundle.main.url(forResource: name, withExtension: "gif", subdirectory: "DesktopPet")
      ?? Bundle.main.url(forResource: name, withExtension: "gif") {
      return NSImage(contentsOf: url)
    }
    return NSImage(systemSymbolName: "pawprint.fill", accessibilityDescription: nil)
  }

  final class Coordinator {
    var currentName: String?
  }
}
