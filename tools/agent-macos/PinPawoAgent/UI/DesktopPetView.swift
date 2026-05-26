import AppKit
import SwiftUI

struct DesktopPetView: View {
  @ObservedObject var appState: AppState

  let onDragChanged: (CGSize) -> Void
  let onDragEnded: () -> Void

  private var activeToolName: String? {
    appState.poller.health?.activeToolName
  }

  private var agentRunPhase: String? {
    appState.poller.health?.agentRunPhase
  }

  private var gifName: String {
    if appState.agent.isStarting { return "thinking" }
    if let tool = activeToolName { return gifName(for: tool) }

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
    appState.agent.isStarting || activeToolName != nil || agentRunPhase != nil
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

  private func gifName(for toolName: String) -> String {
    let normalized = toolName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalized.contains("browser")
      || normalized.contains("playwright")
      || normalized.contains("search")
      || normalized.contains("fetch")
      || normalized.contains("snapshot")
      || normalized.contains("open")
      || normalized.contains("click")
      || normalized.contains("type") {
      return "browser"
    }
    if normalized.contains("audio")
      || normalized.contains("music")
      || normalized.contains("play")
      || normalized.contains("video")
      || normalized.contains("media") {
      return "media"
    }
    if normalized.contains("shell")
      || normalized.contains("command")
      || normalized.contains("file")
      || normalized.contains("read")
      || normalized.contains("write")
      || normalized.contains("edit") {
      return "file"
    }
    return "typing"
  }
}
