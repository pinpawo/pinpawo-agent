import Foundation
import Darwin

@MainActor
final class AgentProcess: ObservableObject {
  @Published var isRunning = false
  @Published var isStarting = false   // true while the async start check is in progress
  @Published var errorMessage: String?
  @Published var logs: [String] = []

  private var process: Process?
  private var outPipe: Pipe?
  private var errPipe: Pipe?
  private var adoptedPID: pid_t?   // PID of a pre-existing process we adopted
  private var isStopping = false    // suppresses spurious exit-code error when we stop
  private let maxLogLines = 200

  // MARK: - Binary discovery

  private func findNode() -> String? {
    // 1. Bundled inside the app for distributable builds.
    if let bundled = Bundle.main.path(forResource: "node", ofType: nil, inDirectory: "bin"),
       FileManager.default.isExecutableFile(atPath: bundled) {
      return bundled
    }

    // 2. Developer override for local testing.
    if let override = ProcessInfo.processInfo.environment["PINPAWO_NODE_PATH"],
       !override.isEmpty,
       FileManager.default.isExecutableFile(atPath: override) {
      return override
    }

    // 3. System locations for dev environments.
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/bin/node",
    ] + nvmNodePaths(home: home)
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
      return path
    }

    // 4. Search via login shell PATH.
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-lc", "which node"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    try? task.run()
    task.waitUntilExit()
    let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let path = output, !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) {
      return path
    }
    return nil
  }

  private func nvmNodePaths(home: String) -> [String] {
    let versionsDir = "\(home)/.nvm/versions/node"
    guard let versions = try? FileManager.default.contentsOfDirectory(atPath: versionsDir) else {
      return []
    }
    return versions.sorted().reversed().map { "\(versionsDir)/\($0)/bin/node" }
  }

  /// Returns the path to `dist/index.js` — bundled inside the .app, or the project dev path.
  private func findDistScript() -> String? {
    // 1. Bundled inside .app Resources/dist/index.js (production)
    if let bundled = Bundle.main.path(forResource: "index", ofType: "js", inDirectory: "dist") {
      return bundled
    }
    // 2. Manual override in config (for dev/testing)
    let devPath = Config.shared.load().agentDistPath
    if let p = devPath, FileManager.default.fileExists(atPath: p) { return p }

    // 3. Well-known dev fallback (same repo layout)
    if let bundlePath = Bundle.main.bundlePath
      .components(separatedBy: "/tools/agent-macos/").first {
      let candidate = "\(bundlePath)/services/local-agent/dist/index.js"
      if FileManager.default.fileExists(atPath: candidate) { return candidate }
    }
    return nil
  }

  // MARK: - Start / Stop

  func start() {
    guard !isRunning, !isStarting else { return }
    errorMessage = nil
    isStarting = true

    // If the agent is already listening (e.g. left over from a previous session),
    // adopt it instead of spawning a duplicate (which would EADDRINUSE).
    Task {
      if await checkHealthEndpoint() {
        let pid = findPIDOnPort(3210)
        await MainActor.run {
          self.adoptedPID = pid
          self.isRunning = true
          self.isStarting = false
          let pidInfo = pid.map { " (pid \($0))" } ?? ""
          self.appendLog("agent already running — adopted existing process\(pidInfo)")
        }
        return
      }
      await MainActor.run {
        self.isStarting = false
        self.launchProcess()
      }
    }
  }

  func stop() {
    guard isRunning else { return }
    isStopping = true

    // Stop an adopted (pre-existing) process by PID
    if let pid = adoptedPID {
      Darwin.kill(pid, SIGINT)
      adoptedPID = nil
      isRunning = false
      isStopping = false
      appendLog("agent stopped")
      return
    }

    guard let p = process else { return }
    // Clear pipe handlers first to stop log delivery and release captured references
    outPipe?.fileHandleForReading.readabilityHandler = nil
    errPipe?.fileHandleForReading.readabilityHandler = nil
    outPipe = nil
    errPipe = nil
    p.interrupt()
    Task {
      try? await Task.sleep(for: .seconds(3))
      if p.isRunning { p.terminate() }
    }
    isRunning = false
    process = nil
    appendLog("agent stopped")
  }

  // MARK: - Helpers

  private func checkHealthEndpoint() async -> Bool {
    guard let url = URL(string: "http://127.0.0.1:3210/health") else { return false }
    var req = URLRequest(url: url, timeoutInterval: 1.5)
    req.httpMethod = "GET"
    LocalServerAuth.authorize(&req)
    do {
      let (_, resp) = try await URLSession.shared.data(for: req)
      return (resp as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }

  /// Find the PID of the process listening on the given TCP port (macOS only).
  private func findPIDOnPort(_ port: Int) -> pid_t? {
    guard (1...65535).contains(port) else { return nil }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    task.arguments = ["-t", "-i", ":\(port)", "-sTCP:LISTEN"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    try? task.run()
    task.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = out?.components(separatedBy: "\n").first,
          let pid = Int32(first) else { return nil }
    return pid_t(pid)
  }

  private func launchProcess() {
    guard let node = findNode() else {
      errorMessage = "找不到可用的 Node.js 运行时；请重新安装 PinPawo Agent，或设置 PINPAWO_NODE_PATH。"
      return
    }
    guard let script = findDistScript() else {
      errorMessage = "找不到 agent dist，请先运行 npm run build（或在设置中指定路径）"
      return
    }

    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [script, "run"]

    var env = ProcessInfo.processInfo.environment
    env["NODE_ENV"] = "production"
    let cfg = Config.shared.load()
    if cfg.browserBackend == "playwright" {
      env["PINPAWO_BROWSER_BACKEND"] = "playwright"
    }
    if let workdir = cfg.workdir, !workdir.isEmpty {
      env["PINPAWO_WORKDIR"] = workdir
    }
    p.environment = env

    let out = Pipe()
    let err = Pipe()
    self.outPipe = out
    self.errPipe = err
    p.standardOutput = out
    p.standardError = err

    out.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
      Task { @MainActor [weak self] in self?.appendLog(line) }
    }
    err.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
      Task { @MainActor [weak self] in self?.appendLog(line) }
    }

    p.terminationHandler = { [weak self] proc in
      let code = proc.terminationStatus
      Task { @MainActor [weak self] in
        guard let self else { return }
        // Clean up pipe handlers to release captured references
        self.outPipe?.fileHandleForReading.readabilityHandler = nil
        self.errPipe?.fileHandleForReading.readabilityHandler = nil
        self.outPipe = nil
        self.errPipe = nil
        self.isRunning = false
        self.process = nil
        // Only show error if the process crashed on its own (not from our stop())
        if code != 0 && !self.isStopping {
          self.errorMessage = "进程退出 (code \(code))，请查看日志"
        }
        self.isStopping = false
      }
    }

    do {
      try p.run()
      process = p
      isRunning = true
      appendLog("agent started (pid \(p.processIdentifier))")
    } catch {
      errorMessage = "启动失败: \(error.localizedDescription)"
    }
  }

  private func appendLog(_ line: String) {
    let lines = line.components(separatedBy: .newlines).filter { !$0.isEmpty }
    logs.append(contentsOf: lines)
    if logs.count > maxLogLines {
      logs.removeFirst(logs.count - maxLogLines)
    }
  }
}
