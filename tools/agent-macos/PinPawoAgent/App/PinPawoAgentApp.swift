import SwiftUI

@main
struct PinPawoAgentApp: App {
  @StateObject private var appState = AppState()

  var body: some Scene {
    MenuBarExtra {
      MenuBarView()
        .environmentObject(appState)
    } label: {
      Image(systemName: appState.agentRunning ? "pawprint.fill" : "pawprint")
    }
    .menuBarExtraStyle(.window)

    Window("设置", id: "settings") {
      SettingsView()
        .environmentObject(appState)
        .onAppear {
          SettingsWindowFocus.bringToFront()
        }
    }
    .windowResizability(.contentSize)
    .defaultSize(width: 560, height: 420)
  }
}
