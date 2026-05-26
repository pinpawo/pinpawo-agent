import Foundation

@MainActor
final class StatusPoller: ObservableObject {
  @Published var health: HealthResponse?
  @Published var reachable = false

  // swiftlint:disable:next force_unwrapping — hardcoded literal, always valid
  private let healthURL = URL(string: "http://127.0.0.1:3210/health")!
  private var timer: Timer?

  func start() {
    timer?.invalidate()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor [weak self] in self?.poll() }
    }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    health = nil
    reachable = false
  }

  // MARK: - Private

  private func poll() {
    Task {
      do {
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 4
        let (data, _) = try await URLSession.shared.data(for: req)
        let h = try JSONDecoder().decode(HealthResponse.self, from: data)
        health = h
        reachable = true
      } catch {
        health = nil
        reachable = false
      }
    }
  }
}
