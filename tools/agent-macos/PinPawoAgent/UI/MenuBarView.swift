import SwiftUI

struct MenuBarView: View {
  @EnvironmentObject private var appState: AppState

  var body: some View {
    switch appState.screen {
    case .llmSetup:
      LLMSettingsView()
    case .actorMissing:
      ActorMissingView()
    case .status:
      StatusView()
    }
  }
}
