import AppKit
import SwiftUI

struct DesktopPetView: View {
  @ObservedObject var appState: AppState

  let onDragChanged: (CGSize) -> Void
  let onDragEnded: () -> Void

  private var activeOperationKind: String? {
    appState.poller.health?.activeOperationKind
  }

  private var agentRunPhase: String? {
    appState.poller.health?.agentRunPhase
  }

  private var gifName: String {
    if appState.agent.isStarting { return "thinking" }
    if activeOperationKind != nil { return gifNameForActiveOperation() }

    switch agentRunPhase {
    case "streaming":
      return "typing"
    case "waiting_human":
      return "waiting"
    case "interrupted", "error":
      return "interrupted"
    case "thinking", "using_tool":
      return "thinking"
    default:
      return appState.agent.isRunning ? "waiting" : "do-not-disturb"
    }
  }

  private var shouldAnimate: Bool {
    appState.agent.isStarting || activeOperationKind != nil || agentRunPhase != nil
  }

  var body: some View {
    AnimatedGIFView(name: gifName, animates: shouldAnimate)
      .frame(width: 144, height: 144)
      .shadow(color: .black.opacity(0.22), radius: 10, y: 5)
      .scaleEffect(appState.agent.isStarting ? 0.96 : 1)
      .animation(.easeInOut(duration: 0.18), value: gifName)
      .frame(width: 160, height: 160)
      .contentShape(Rectangle())
      .onHover { hovering in
        if hovering {
          NSCursor.openHand.set()
        } else {
          NSCursor.arrow.set()
        }
      }
      .gesture(
        DragGesture(minimumDistance: 1)
          .onChanged { onDragChanged($0.translation) }
          .onEnded { _ in onDragEnded() }
      )
  }

  private func gifNameForActiveOperation() -> String {
    let parts = [
      appState.poller.health?.activeOperationKind,
      appState.poller.health?.activeOperationTitle,
      appState.poller.health?.activeOperationTarget,
      appState.poller.health?.activeOperationSummary,
    ].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    let descriptor = parts.joined(separator: " ")
    if descriptor.contains("browser")
      || descriptor.contains("playwright")
      || descriptor.contains("search")
      || descriptor.contains("fetch")
      || descriptor.contains("snapshot")
      || descriptor.contains("open")
      || descriptor.contains("click")
      || descriptor.contains("type") {
      return "browser"
    }
    if descriptor.contains("audio")
      || descriptor.contains("music")
      || descriptor.contains("play")
      || descriptor.contains("video")
      || descriptor.contains("media") {
      return "media"
    }
    if descriptor.contains("shell")
      || descriptor.contains("command")
      || descriptor.contains("file")
      || descriptor.contains("read")
      || descriptor.contains("write")
      || descriptor.contains("edit") {
      return "file"
    }
    return "typing"
  }
}
