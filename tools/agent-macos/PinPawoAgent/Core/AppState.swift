import Foundation
import Combine
import ServiceManagement

enum AppScreen {
  case llmSetup
  case actorMissing
  case status
}

@MainActor
final class AppState: ObservableObject {
  @Published var screen: AppScreen = .llmSetup
  @Published var launchAtLogin = false
  @Published private(set) var desktopPetVisible = true

  let agent = AgentProcess()
  let poller = StatusPoller()
  private let desktopPet = DesktopPetController()
  private var cancellables = Set<AnyCancellable>()
  private let desktopPetVisibleKey = "desktopPetVisible"

  var agentRunning: Bool { agent.isRunning }

  init() {
    if UserDefaults.standard.object(forKey: desktopPetVisibleKey) != nil {
      desktopPetVisible = UserDefaults.standard.bool(forKey: desktopPetVisibleKey)
    }
    launchAtLogin = SMAppService.mainApp.status == .enabled
    screen = resolveScreen()
    // Forward agent & poller changes so views that observe AppState re-render automatically
    agent.objectWillChange
      .sink { [weak self] in self?.objectWillChange.send() }
      .store(in: &cancellables)
    poller.objectWillChange
      .sink { [weak self] in self?.objectWillChange.send() }
      .store(in: &cancellables)
    DispatchQueue.main.async { [weak self] in
      self?.syncDesktopPet()
    }
  }

  // MARK: - Screen routing

  func resolveScreen() -> AppScreen {
    let c = Config.shared
    if !c.hasLlmConfig { return .llmSetup }
    if !c.hasActor { return .actorMissing }
    return .status
  }

  func advance() {
    screen = resolveScreen()
    if screen == .status {
      startAgent()
    }
  }

  // MARK: - Agent lifecycle

  func startAgent() {
    agent.start()
    poller.start()
  }

  func stopAgent() {
    agent.stop()
    poller.stop()
  }

  // MARK: - Desktop pet

  func toggleDesktopPet() {
    showDesktopPet()
  }

  func showDesktopPet() {
    desktopPetVisible = true
    UserDefaults.standard.set(true, forKey: desktopPetVisibleKey)
    desktopPet.show(appState: self, recenter: true)
  }

  func setDesktopPetVisible(_ visible: Bool) {
    desktopPetVisible = visible
    UserDefaults.standard.set(visible, forKey: desktopPetVisibleKey)
    syncDesktopPet()
  }

  private func syncDesktopPet() {
    if desktopPetVisible {
      desktopPet.show(appState: self)
    } else {
      desktopPet.hide()
    }
  }

  // MARK: - Launch at login

  func toggleLaunchAtLogin() {
    do {
      if launchAtLogin {
        try SMAppService.mainApp.unregister()
        launchAtLogin = false
      } else {
        try SMAppService.mainApp.register()
        launchAtLogin = true
      }
    } catch {}
  }
}
