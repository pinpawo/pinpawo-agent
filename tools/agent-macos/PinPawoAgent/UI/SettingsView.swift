import SwiftUI

// MARK: - Pane enum

private enum SettingsPane: String, CaseIterable, Identifiable {
  case actor        = "角色"
  case llm          = "LLM"
  case capabilities = "能力"

  var id: String { rawValue }

  var icon: String {
    switch self {
    case .actor:        return "pawprint.fill"
    case .llm:          return "cpu"
    case .capabilities: return "wrench.and.screwdriver.fill"
    }
  }

  var tint: Color {
    switch self {
    case .actor:        return .orange
    case .llm:          return .purple
    case .capabilities: return .green
    }
  }
}

// MARK: - Root

struct SettingsView: View {
  @EnvironmentObject private var appState: AppState
  @State private var selectedPane: SettingsPane = .actor

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(SettingsPane.allCases) { pane in
          Button {
            selectedPane = pane
          } label: {
            HStack(spacing: 10) {
              ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                  .fill(pane.tint)
                  .frame(width: 24, height: 24)
                Image(systemName: pane.icon)
                  .font(.system(size: 12, weight: .medium))
                  .foregroundColor(.white)
              }
              Text(pane.rawValue)
                .font(.system(size: 15, weight: .medium))
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(selectedPane == pane ? Color.accentColor.opacity(0.18) : .clear)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(selectedPane == pane ? Color.accentColor.opacity(0.35) : .clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundColor(selectedPane == pane ? .primary : .secondary)
        }

        Spacer()
      }
      .frame(width: 170)
      .padding(12)

      Divider()

      Group {
        switch selectedPane {
        case .actor:        ActorSettingsPane().environmentObject(appState)
        case .llm:          LLMSettingsPane()
        case .capabilities: CapabilitiesSettingsPane()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .navigationTitle("设置")
  }
}

// MARK: - Actor Pane

private struct ActorSettingsPane: View {
  @EnvironmentObject private var appState: AppState

  @State private var actors: [Actor] = []
  @State private var loading = false
  @State private var errorMsg: String?
  @State private var currentId: String?

  var body: some View {
    Form {
      Section {
        if let id = currentId, let current = actors.first(where: { $0.id == id }) {
          LabeledContent("当前角色") {
            HStack(spacing: 4) {
              Text(current.name).fontWeight(.medium)
              if let species = current.species {
                Text("·").foregroundColor(.secondary)
                Text(species).foregroundColor(.secondary)
              }
            }
          }
        } else {
          LabeledContent("当前角色") {
            Text("未选择").foregroundColor(.secondary)
          }
        }
      } header: {
        Text("活跃角色")
      }

      Section {
        if loading {
          HStack {
            ProgressView().controlSize(.small)
            Text("加载中…").foregroundColor(.secondary).font(.callout)
          }
        } else if let err = errorMsg {
          Text(err).foregroundColor(.red).font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        } else if actors.isEmpty {
          Text("未找到宠物，请先在 PinPawo App 中创建一只宠物。")
            .foregroundColor(.secondary).font(.callout)
        } else {
          ForEach(actors) { actor in
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(actor.name).font(.body)
                if let species = actor.species {
                  Text(species + (actor.stage.map { " · \($0)" } ?? ""))
                    .font(.caption).foregroundColor(.secondary)
                }
              }
              Spacer()
              if actor.id == currentId {
                Image(systemName: "checkmark.circle.fill")
                  .foregroundColor(.accentColor)
              } else {
                Button("选择") { select(actor) }
                  .buttonStyle(.bordered).controlSize(.small)
              }
            }
          }
        }
      } header: {
        HStack {
          Text("可用宠物")
          Spacer()
          Button {
            Task { await loadActors() }
          } label: {
            Image(systemName: "arrow.clockwise").font(.caption2)
          }
          .buttonStyle(.plain)
          .foregroundColor(.secondary)
        }
      }
    }
    .formStyle(.grouped)
    .task {
      currentId = Config.shared.load().actorId
      await loadActors()
    }
  }

  private func select(_ actor: Actor) {
    Config.shared.update { $0.actorId = actor.id; $0.actorName = actor.name }
    currentId = actor.id
    appState.advance()
  }

  private func loadActors() async {
    loading = true
    errorMsg = nil
    do {
      actors = try await fetchActors()
    } catch {
      errorMsg = error.localizedDescription
    }
    loading = false
  }

}

// MARK: - LLM Pane

private enum GlobalReviewPolicyOption: String, CaseIterable, Identifiable {
  case requireAuthorization = "require_authorization"
  case autoAuthorization = "auto_authorization"
  case fullAccess = "full_access"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .requireAuthorization: return "需要授权"
    case .autoAuthorization: return "自动授权"
    case .fullAccess: return "完全访问"
    }
  }

  var detail: String {
    switch self {
    case .requireAuthorization: return "需要 review 的操作都会等待你确认。"
    case .autoAuthorization: return "先由 LLM 做安全判断；安全时自动授权，不确定时询问你。"
    case .fullAccess: return "跳过 review，直接执行工具请求。"
    }
  }

  static func from(_ raw: String?) -> GlobalReviewPolicyOption {
    guard let raw else { return .requireAuthorization }
    switch raw {
    case "ask", "manual", "require", "require-review", "require-authorization", "require-approval", "authorization-required", "custom":
      return .requireAuthorization
    case "auto", "auto-review", "auto-authorization", "auto-authorize", "automatic-authorization", "automatic", "auto-approve":
      return .autoAuthorization
    case "full-access", "always-allow", "allow-all", "unrestricted", "trusted":
      return .fullAccess
    default:
      return GlobalReviewPolicyOption(rawValue: raw) ?? .requireAuthorization
    }
  }
}

private struct LLMSettingsPane: View {
  @State private var apiKey = ""
  @State private var baseUrl = ""
  @State private var model = ""
  @State private var workdir = ""
  @State private var subagentThinking = false
  @State private var globalReviewPolicy: GlobalReviewPolicyOption = .requireAuthorization
  @State private var savedFlash = false
  @State private var errorMsg: String?

  private var defaultWorkdir: String {
    FileManager.default.homeDirectoryForCurrentUser.path
  }

  var body: some View {
    Form {
      Section("模型配置") {
        SecureField("API Key", text: $apiKey)
        TextField("Base URL", text: $baseUrl)
        TextField("Model", text: $model)
      }

      Section {
        Toggle("子任务启用深度思考", isOn: $subagentThinking)
      } header: {
        Text("推理设置")
      } footer: {
        Text("关闭后子任务（subagent）调用不使用模型的思考/推理模式，可降低延迟和成本。重启 Agent 生效。")
      }

      Section {
        Picker("全局访问策略", selection: $globalReviewPolicy) {
          ForEach(GlobalReviewPolicyOption.allCases) { option in
            Text(option.title).tag(option)
          }
        }
        .pickerStyle(.segmented)

        Text(globalReviewPolicy.detail)
          .font(.caption)
          .foregroundColor(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } header: {
        Text("授权设置")
      } footer: {
        Text("控制文件写入、命令执行等需要 review 的操作。重启 Agent 生效。")
      }

      Section {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            TextField("留空使用默认工作目录", text: $workdir)
              .textFieldStyle(.roundedBorder)
            if !workdir.isEmpty {
              Button {
                workdir = ""
              } label: {
                Image(systemName: "xmark.circle.fill").font(.caption)
              }
              .buttonStyle(.plain)
              .foregroundColor(.secondary)
              .help("恢复默认工作目录")
            }
            Button {
              let panel = NSOpenPanel()
              panel.canChooseFiles = false
              panel.canChooseDirectories = true
              panel.allowsMultipleSelection = false
              panel.prompt = "选择"
              if panel.runModal() == .OK, let url = panel.url {
                workdir = url.path
              }
            } label: {
              Image(systemName: "folder").font(.caption)
            }
            .buttonStyle(.bordered).controlSize(.small)
          }
          Text("默认：\(defaultWorkdir)")
            .font(.caption)
            .foregroundColor(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      } header: {
        Text("Agent 工作目录")
      } footer: {
        Text("相对路径文件操作的基准目录，默认为用户主目录。重启 Agent 生效。")
      }

      Section {
        if let err = errorMsg {
          Text(err).foregroundColor(.red).font(.callout)
        }
        HStack(spacing: 12) {
          Button("保存") { save() }
            .buttonStyle(.borderedProminent)
            .disabled(apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
          if savedFlash {
            Label("已保存", systemImage: "checkmark.circle.fill")
              .font(.callout).foregroundColor(.green)
          }
        }
      }
    }
    .formStyle(.grouped)
    .task {
      let c = Config.shared.load()
      apiKey  = c.llmApiKey ?? ""
      baseUrl = c.llmBaseUrl
      model   = c.llmModel
      workdir = cleanWorkdir(c.workdir ?? "")
      subagentThinking = c.subagentThinking ?? false
      globalReviewPolicy = .from(c.globalReviewPolicy)
    }
  }

  private func save() {
    let key = apiKey.trimmingCharacters(in: .whitespaces)
    guard !key.isEmpty else { errorMsg = "API Key 不能为空"; return }
    errorMsg = nil
    Config.shared.update {
      $0.llmApiKey = key
      $0.llmBaseUrl = baseUrl.isEmpty ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : baseUrl
      $0.llmModel   = model.isEmpty ? "qwen3.5-plus" : model
      let normalizedWorkdir = cleanWorkdir(workdir)
      $0.workdir    = normalizedWorkdir.isEmpty ? nil : normalizedWorkdir
      $0.subagentThinking = subagentThinking
      $0.globalReviewPolicy = globalReviewPolicy.rawValue
    }
    savedFlash = true
    Task { try? await Task.sleep(for: .seconds(2)); savedFlash = false }
  }

  private func cleanWorkdir(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let duplicatedDefaultPrefix = defaultWorkdir + " "
    if trimmed.hasPrefix(duplicatedDefaultPrefix) {
      return String(trimmed.dropFirst(duplicatedDefaultPrefix.count))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return trimmed
  }
}

// MARK: - Capabilities Pane

private struct BrowserProfile: Identifiable {
  let id = UUID()
  let name: String
  let url: URL
  var lastModified: Date?
  var sizeBytes: Int64 = -1
}

private struct BrowserOptionStatus {
  let chromePath: String
  let chromeAvailable: Bool
  let playwrightCorePath: String?

  var supportsPlaywright: Bool { playwrightCorePath != nil && chromeAvailable }
  var supportsExtension: Bool { chromeAvailable }
  var hasAnyExternalSupport: Bool { supportsPlaywright || supportsExtension }

  static let fallback = BrowserOptionStatus(
    chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chromeAvailable: false,
    playwrightCorePath: nil
  )

  /// Run `node dist/index.js detect` and parse the JSON output.
  /// Detection logic lives in the Node agent so it only needs to be maintained once.
  static func detect() -> BrowserOptionStatus {
    guard let node = findNodePath(), let script = findDistScriptPath() else {
      return fallback
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: node)
    task.arguments = [script, "detect"]
    task.environment = ProcessInfo.processInfo.environment
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
      try task.run()
      task.waitUntilExit()
    } catch {
      return fallback
    }
    guard task.terminationStatus == 0 else { return fallback }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let parsed = try? JSONDecoder().decode(DetectOutput.self, from: data) else {
      return fallback
    }
    return BrowserOptionStatus(
      chromePath: parsed.browser.chromePath,
      chromeAvailable: parsed.browser.chromeAvailable,
      playwrightCorePath: parsed.browser.playwrightCorePath
    )
  }

  // Minimal node/dist discovery — mirrors AgentProcess logic without requiring an instance.
  private static func findNodePath() -> String? {
    if let bundled = Bundle.main.path(forResource: "node", ofType: nil, inDirectory: "bin"),
       FileManager.default.isExecutableFile(atPath: bundled) {
      return bundled
    }
    if let override = ProcessInfo.processInfo.environment["PINPAWO_NODE_PATH"],
       !override.isEmpty, FileManager.default.isExecutableFile(atPath: override) {
      return override
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
      return path
    }
    // nvm
    let nvmDir = "\(home)/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
      for version in versions.sorted().reversed() {
        let path = "\(nvmDir)/\(version)/bin/node"
        if FileManager.default.isExecutableFile(atPath: path) { return path }
      }
    }
    return nil
  }

  private static func findDistScriptPath() -> String? {
    if let bundled = Bundle.main.path(forResource: "index", ofType: "js", inDirectory: "dist") {
      return bundled
    }
    let devPath = Config.shared.load().agentDistPath
    if let p = devPath, FileManager.default.fileExists(atPath: p) { return p }
    if let bundlePath = Bundle.main.bundlePath
      .components(separatedBy: "/tools/agent-macos/").first {
      let candidate = "\(bundlePath)/services/local-agent/dist/index.js"
      if FileManager.default.fileExists(atPath: candidate) { return candidate }
    }
    return nil
  }

  private struct DetectOutput: Codable {
    let browser: BrowserDetect
  }

  private struct BrowserDetect: Codable {
    let chromePath: String
    let chromeAvailable: Bool
    let playwrightCorePath: String?
  }
}

/// Decoded from dist/capability-manifest.json (built-ins) or
/// ~/.pinpawo/capabilities/*/manifest.json (user plugins).
private struct CapabilityManifestEntry: Codable, Identifiable {
  let id: String
  let name: String
  let description: String
  let icon: String
  let color: String
  var defaultEnabled: Bool
  var builtIn: Bool?
  var comingSoon: Bool?
}

private struct CapabilityManifest: Codable {
  let version: Int
  let capabilities: [CapabilityManifestEntry]
}

private struct CapabilityItem: Identifiable {
  let id: String
  let meta: CapabilityManifestEntry
  let isUserPlugin: Bool
}

private enum CapabilityDetailPage: Hashable {
  case browser
  case capability(String) // id
}

private struct CapabilitiesSettingsPane: View {
  @EnvironmentObject private var appState: AppState

  @State private var items: [CapabilityItem]
  /// Enabled states keyed by capability id. Separated from items so that
  /// toggling a switch never mutates the items array and won't reset navigation.
  @State private var enabledStates: [String: Bool]
  @State private var extraDirInput: String = ""
  /// Manual navigation: nil = list, non-nil = detail page
  @State private var detailPage: CapabilityDetailPage?

  init() {
    let cfg = Config.shared.load()
    let savedCaps = cfg.capabilities ?? [:]
    let loaded = Self.loadItemsSync(cfg: cfg)
    var states: [String: Bool] = ["browser": savedCaps["browser"] ?? true]
    for item in loaded {
      states[item.id] = savedCaps[item.id] ?? item.meta.defaultEnabled
    }
    _items = State(initialValue: loaded)
    _enabledStates = State(initialValue: states)
  }

  private static let defaultCapabilitiesDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".pinpawo/capabilities")

  private static func resolveCapabilityDirs(cfg: AgentConfig) -> [URL] {
    var dirs: [URL] = [defaultCapabilitiesDir]
    for raw in cfg.capabilityDirs ?? [] {
      let expanded = raw.hasPrefix("~/")
        ? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(String(raw.dropFirst(2)))
        : URL(fileURLWithPath: raw)
      if !dirs.contains(expanded) { dirs.append(expanded) }
    }
    return dirs
  }

  private func bindEnabled(_ id: String, default defaultValue: Bool = true) -> Binding<Bool> {
    Binding(
      get: { enabledStates[id] ?? defaultValue },
      set: { newValue in
        enabledStates[id] = newValue
        Config.shared.update { cfg in
          var caps = cfg.capabilities ?? [:]
          caps[id] = newValue
          cfg.capabilities = caps
        }
      }
    )
  }

  var body: some View {
    if let page = detailPage {
      detailView(for: page)
    } else {
      listView
    }
  }

  // MARK: - Detail view

  @ViewBuilder
  private func detailView(for page: CapabilityDetailPage) -> some View {
    VStack(spacing: 0) {
      // Back bar
      HStack {
        Button {
          detailPage = nil
        } label: {
          HStack(spacing: 4) {
            Image(systemName: "chevron.left")
              .font(.system(size: 13, weight: .semibold))
            Text("能力")
              .font(.system(size: 14))
          }
        }
        .buttonStyle(.plain)
        .foregroundColor(.accentColor)
        Spacer()
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)

      // Detail content
      switch page {
      case .browser:
        BrowserConfigView()
      case .capability(let id):
        if let item = items.first(where: { $0.id == id }) {
          CapabilityDetailView(item: item, enabled: bindEnabled(item.id, default: item.meta.defaultEnabled))
        }
      }
    }
  }

  // MARK: - Row helper

  /// A full-width tappable row that navigates to a detail page.
  /// The Toggle inside the label keeps its own hit area;
  /// tapping anywhere else on the row triggers navigation.
  private func capabilityNavigationRow<Label: View>(
    page: CapabilityDetailPage,
    @ViewBuilder label: () -> Label
  ) -> some View {
    HStack {
      label()
      Image(systemName: "chevron.right")
        .font(.system(size: 12, weight: .semibold))
        .foregroundColor(Color.secondary.opacity(0.5))
    }
    .contentShape(Rectangle())
    .onTapGesture { detailPage = page }
  }

  // MARK: - List view

  private var listView: some View {
    Form {
      let builtIns = items.filter { !$0.isUserPlugin }
      let userPlugins = items.filter { $0.isUserPlugin }

      // ── Built-in capabilities (browser + manifest entries) ─────────

      Section {
        // Browser capability row
        capabilityNavigationRow(page: .browser) {
          CapabilityRowLabel(
            icon: "globe", tint: .blue,
            name: "浏览器", description: "为能力提供网页浏览支持",
            enabled: bindEnabled("browser")
          )
        }

        // Other built-in capabilities from manifest
        ForEach(builtIns) { item in
          capabilityNavigationRow(page: .capability(item.id)) {
            CapabilityRowLabel(item: item, enabled: bindEnabled(item.id, default: item.meta.defaultEnabled))
          }
        }
      } header: {
        Text("内置能力")
      } footer: {
        Text("能力开关仅在 Agent 重启后生效。")
      }

      // ── User plugins ───────────────────────────────────────────────

      if !userPlugins.isEmpty {
        Section {
          ForEach(userPlugins) { item in
            capabilityNavigationRow(page: .capability(item.id)) {
              CapabilityRowLabel(item: item, enabled: bindEnabled(item.id, default: item.meta.defaultEnabled))
            }
          }
        } header: {
          Text("用户插件")
        } footer: {
          Text("放置于 ~/.pinpawo/capabilities/<name>/ 目录下的自定义能力插件。")
        }
      }

      // ── Plugin directories ─────────────────────────────────────────

      Section {
        ForEach(resolvedExtraDirs(), id: \.path) { url in
          HStack {
            Image(systemName: "folder").foregroundColor(.secondary)
            Text(url.path.replacingOccurrences(
              of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
              .font(.callout)
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer()
            Button {
              removeExtraDir(url)
            } label: {
              Image(systemName: "minus.circle").foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
          }
        }

        HStack(spacing: 6) {
          Button {
            loadItems()
            Task { await rescanRunningAgentCapabilities() }
          } label: {
            Label("重新扫描", systemImage: "arrow.clockwise")
              .font(.callout)
          }
          .buttonStyle(.plain)
          .foregroundColor(.accentColor)

          Spacer()

          Button {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "添加"
            if panel.runModal() == .OK, let url = panel.url {
              addExtraDir(url)
            }
          } label: {
            Label("添加插件目录…", systemImage: "plus.circle")
              .font(.callout)
          }
          .buttonStyle(.plain)
          .foregroundColor(.accentColor)

          Button("打开默认目录") {
            let url = CapabilitiesSettingsPane.defaultCapabilitiesDir
            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            NSWorkspace.shared.open(url)
          }
          .buttonStyle(.plain)
          .font(.callout)
          .foregroundColor(.secondary)
        }
      } header: {
        Text("插件目录")
      } footer: {
        Text("默认目录：~/.pinpawo/capabilities/。可添加多个目录，方便管理 local-agent 项目中的自定义插件。点击重新扫描可刷新列表；能力开关仍需重启 Agent 后生效。")
      }
    }
    .formStyle(.grouped)
  }

  // MARK: - Directory management

  private func resolvedExtraDirs() -> [URL] {
    let cfg = Config.shared.load()
    return (cfg.capabilityDirs ?? []).compactMap { raw -> URL? in
      let expanded = raw.hasPrefix("~/")
        ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(raw.dropFirst(2)))
        : URL(fileURLWithPath: raw)
      return expanded
    }
  }

  private func addExtraDir(_ url: URL) {
    Config.shared.update { cfg in
      var dirs = cfg.capabilityDirs ?? []
      let path = url.path
      if !dirs.contains(path) { dirs.append(path) }
      cfg.capabilityDirs = dirs
    }
    loadItems()
    Task { await rescanRunningAgentCapabilities() }
  }

  private func removeExtraDir(_ url: URL) {
    Config.shared.update { cfg in
      cfg.capabilityDirs = (cfg.capabilityDirs ?? []).filter { $0 != url.path }
    }
    loadItems()
    Task { await rescanRunningAgentCapabilities() }
  }

  // MARK: - Capability loading

  private static func loadItemsSync(cfg: AgentConfig) -> [CapabilityItem] {
    var loaded: [CapabilityItem] = []
    var seenIds = Set<String>()

    if let bundleURL = Bundle.main.url(forResource: "capability-manifest", withExtension: "json",
                                       subdirectory: "dist"),
       let data = try? Data(contentsOf: bundleURL),
       let manifest = try? JSONDecoder().decode(CapabilityManifest.self, from: data) {
      for entry in manifest.capabilities {
        guard !seenIds.contains(entry.id) else { continue }
        seenIds.insert(entry.id)
        loaded.append(CapabilityItem(id: entry.id, meta: entry, isUserPlugin: false))
      }
    }

    let fm = FileManager.default
    for scanDir in resolveCapabilityDirs(cfg: cfg) {
      guard let entries = try? fm.contentsOfDirectory(
        at: scanDir, includingPropertiesForKeys: [.isDirectoryKey]
      ) else { continue }
      for dir in entries {
        guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
        let manifestURL = dir.appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: manifestURL),
              let entry = try? JSONDecoder().decode(CapabilityManifestEntry.self, from: data),
              !entry.id.isEmpty,
              !seenIds.contains(entry.id)
        else { continue }
        seenIds.insert(entry.id)
        loaded.append(CapabilityItem(id: entry.id, meta: entry, isUserPlugin: true))
      }
    }

    return loaded
  }

  private func loadItems() {
    let cfg = Config.shared.load()
    let savedCaps = cfg.capabilities ?? [:]
    let loaded = Self.loadItemsSync(cfg: cfg)
    items = loaded

    var nextStates: [String: Bool] = ["browser": savedCaps["browser"] ?? true]
    for item in loaded {
      nextStates[item.id] = savedCaps[item.id] ?? item.meta.defaultEnabled
    }
    enabledStates = nextStates

    let validIds = Set(loaded.map(\.id)).union(["browser"])
    Config.shared.update { cfg in
      var caps = cfg.capabilities ?? [:]
      caps = caps.filter { validIds.contains($0.key) }
      cfg.capabilities = caps
    }

    if let page = detailPage,
       case .capability(let id) = page,
       !validIds.contains(id) {
      detailPage = nil
    }
  }

  private func rescanRunningAgentCapabilities() async {
    guard appState.agent.isRunning else { return }
    guard let url = URL(string: "http://127.0.0.1:3210/capabilities/rescan") else { return }
    var req = URLRequest(url: url)
    req.timeoutInterval = 6
    LocalServerAuth.authorize(&req)
    _ = try? await URLSession.shared.data(for: req)
  }
}

// MARK: - Browser Config Detail View

private struct BrowserConfigView: View {
  @EnvironmentObject private var appState: AppState

  @State private var browserBackend: String = "auto"
  @State private var browserSupport = BrowserOptionStatus.detect()
  @State private var profiles: [BrowserProfile] = []
  @State private var profilesLoading = true
  @State private var deleteTarget: BrowserProfile?
  @State private var showDeleteConfirm = false
  @State private var copiedCommand: String?

  private static let sessionsURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".pinpawo/sessions")

  var body: some View {
    Form {
      // ── Engine selection & availability ─────────────────────────────

      Section {
        Picker("引擎", selection: $browserBackend) {
          Text("自动检测").tag("auto")
          if browserSupport.supportsPlaywright {
            Text("Playwright + Chrome").tag("playwright")
          }
          if browserSupport.supportsExtension {
            Text("Chrome 扩展（实验性）").tag("extension")
          }
        }
        .pickerStyle(.automatic)
        .disabled(!browserSupport.hasAnyExternalSupport)
        .onChange(of: browserBackend) { value in
          let normalized: String
          switch value {
          case "playwright" where browserSupport.supportsPlaywright:
            normalized = "playwright"
          case "extension" where browserSupport.supportsExtension:
            normalized = "extension"
          default:
            normalized = "auto"
          }
          browserBackend = normalized
          Config.shared.update { $0.browserBackend = normalized == "auto" ? nil : normalized }
        }

        VStack(alignment: .leading, spacing: 4) {
          availabilityRow("Playwright + Chrome", available: browserSupport.supportsPlaywright)
          availabilityRow("Chrome 扩展", available: browserSupport.supportsExtension)
        }
        .font(.callout)

        if !browserSupport.supportsPlaywright {
          Divider()
          VStack(alignment: .leading, spacing: 8) {
            installGuideRow(
              label: "安装 Playwright",
              detail: FileManager.default.isExecutableFile(atPath: browserSupport.chromePath)
                ? "缺少 playwright-core" : "缺少 playwright-core 和 Chrome 浏览器",
              command: "npm install -g playwright-core"
            )
          }
        }
      } header: {
        HStack {
          Text("浏览器引擎")
          Spacer()
          Button {
            Task { await refreshBrowserSupport() }
          } label: {
            Image(systemName: "arrow.clockwise").font(.caption2)
          }
          .buttonStyle(.plain)
          .foregroundColor(.secondary)
          .help("重新检测")
        }
      } footer: {
        Text("扩展模式需先加载 PinPawo 扩展并注册 Native Host；P0 支持打开、快照和断开。修改引擎后需重启 Agent 生效。")
      }

      // ── Session profiles ───────────────────────────────────────────

      Section {
        if profilesLoading {
          HStack {
            ProgressView().controlSize(.small)
            Text("加载中…").foregroundColor(.secondary).font(.callout)
          }
        } else if profiles.isEmpty {
          HStack {
            Image(systemName: "tray").foregroundColor(.secondary)
            Text("暂无保存的浏览器会话").foregroundColor(.secondary).font(.callout)
          }
        } else {
          ForEach(profiles) { profile in
            HStack(spacing: 10) {
              Image(systemName: "person.crop.circle")
                .foregroundColor(.accentColor)
              VStack(alignment: .leading, spacing: 2) {
                Text(profile.name).font(.body)
                HStack(spacing: 4) {
                  if profile.sizeBytes >= 0 {
                    Text(formatSize(profile.sizeBytes))
                      .font(.caption2).foregroundColor(.secondary)
                  } else {
                    Text("计算中…").font(.caption2).foregroundColor(.secondary)
                  }
                  if let date = profile.lastModified {
                    Text("·").font(.caption2).foregroundColor(.secondary)
                    Text(relativeDate(date)).font(.caption2).foregroundColor(.secondary)
                  }
                }
              }
              Spacer()
              Button {
                deleteTarget = profile
                showDeleteConfirm = true
              } label: {
                Image(systemName: "trash").font(.caption)
              }
              .buttonStyle(.plain)
              .foregroundColor(.secondary)
            }
          }
        }
      } header: {
        HStack {
          Text("会话 Profiles")
          Spacer()
          Button {
            Task { await reloadProfiles() }
          } label: {
            Image(systemName: "arrow.clockwise").font(.caption2)
          }
          .buttonStyle(.plain)
          .foregroundColor(.secondary)
        }
      } footer: {
        Text("Profiles 存储于 ~/.pinpawo/sessions/，每个 profile 对应独立的浏览器登录状态。")
      }
    }
    .formStyle(.grouped)
    .confirmationDialog(
      "删除 \"\(deleteTarget?.name ?? "")\"？",
      isPresented: $showDeleteConfirm,
      titleVisibility: .visible
    ) {
      Button("删除", role: .destructive) {
        if let t = deleteTarget { deleteProfile(t) }
      }
      Button("取消", role: .cancel) {}
    } message: {
      Text("该 profile 下的所有登录状态（cookies、localStorage 等）将被永久删除，无法恢复。")
    }
    .task {
      await refreshBrowserSupport(refreshRunningAgent: false)
      browserBackend = Config.shared.load().browserBackend ?? "auto"
      if browserBackend == "playwright" && !browserSupport.supportsPlaywright {
        browserBackend = "auto"
        Config.shared.update { $0.browserBackend = nil }
      }
      if browserBackend == "extension" && !browserSupport.supportsExtension {
        browserBackend = "auto"
        Config.shared.update { $0.browserBackend = nil }
      }
      if browserBackend == "agent-browser" {
        browserBackend = "auto"
        Config.shared.update { $0.browserBackend = nil }
      }
      await reloadProfiles()
    }
  }

  // MARK: - Helpers

  private func refreshBrowserSupport(refreshRunningAgent: Bool = true) async {
    browserSupport = BrowserOptionStatus.detect()
    guard refreshRunningAgent, appState.agent.isRunning else { return }
    guard let url = URL(string: "http://127.0.0.1:3210/health?refresh_toolkit=browser") else { return }
    var req = URLRequest(url: url)
    req.timeoutInterval = 4
    LocalServerAuth.authorize(&req)
    _ = try? await URLSession.shared.data(for: req)
  }

  private func availabilityRow(_ label: String, available: Bool) -> some View {
    HStack(spacing: 8) {
      Image(systemName: available ? "checkmark.circle.fill" : "xmark.circle.fill")
        .foregroundColor(available ? .green : .secondary)
      Text(label)
      Spacer()
      Text(available ? "可用" : "不可用")
        .foregroundColor(.secondary)
    }
  }

  private func installGuideRow(label: String, detail: String, command: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.callout).fontWeight(.medium)
      Text(detail).font(.caption).foregroundColor(.secondary)
      HStack(spacing: 6) {
        Text(command)
          .font(.system(size: 11, design: .monospaced))
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(Color.primary.opacity(0.06))
          .cornerRadius(4)
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command, forType: .string)
          copiedCommand = command
          Task {
            try? await Task.sleep(for: .seconds(2))
            if copiedCommand == command { copiedCommand = nil }
          }
        } label: {
          Image(systemName: copiedCommand == command ? "checkmark" : "doc.on.doc")
            .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundColor(copiedCommand == command ? .green : .secondary)
        .help("复制到剪贴板")
      }
    }
  }

  private func reloadProfiles() async {
    profilesLoading = true
    let sessionsURL = BrowserConfigView.sessionsURL
    // Move file I/O off the main thread
    let result: [BrowserProfile] = await Task.detached {
      let fm = FileManager.default
      var profiles: [BrowserProfile] = []
      guard let items = try? fm.contentsOfDirectory(
        at: sessionsURL,
        includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey]
      ) else { return profiles }
      for url in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
        guard (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
        let modDate = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        profiles.append(BrowserProfile(name: url.lastPathComponent, url: url, lastModified: modDate))
      }
      return profiles
    }.value
    profiles = result
    profilesLoading = false
    // Calculate directory sizes in background, update UI incrementally
    for profile in result {
      let url = profile.url
      let name = profile.name
      let size = await Task.detached { directorySize(url) }.value
      if let idx = profiles.firstIndex(where: { $0.name == name }) {
        profiles[idx].sizeBytes = size
      }
    }
  }

  private func deleteProfile(_ profile: BrowserProfile) {
    try? FileManager.default.removeItem(at: profile.url)
    profiles.removeAll { $0.id == profile.id }
  }

  private func formatSize(_ bytes: Int64) -> String {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = [.useGB, .useMB, .useKB]
    formatter.countStyle = .file
    return formatter.string(fromByteCount: bytes)
  }

  private func relativeDate(_ date: Date) -> String {
    let diff = -date.timeIntervalSinceNow
    if diff < 60 { return "刚刚" }
    let m = Int(diff) / 60
    if m < 60 { return "\(m)m 前" }
    let h = m / 60
    if h < 24 { return "\(h)h 前" }
    return "\(h / 24)d 前"
  }
}

// MARK: - Capability Row Label (used inside NavigationLink)

private func capabilityTint(_ color: String) -> Color {
  switch color {
  case "blue":   return .blue
  case "orange": return .orange
  case "purple": return .purple
  case "green":  return .green
  case "red":    return .red
  case "pink":   return .pink
  default:       return .gray
  }
}

/// Row label that shows icon, name, description, badges, and toggle.
/// Used as `label:` of a `NavigationLink` so the row gets a disclosure chevron.
private struct CapabilityRowLabel: View {
  let icon: String
  let tint: Color
  let name: String
  let description: String
  let isUserPlugin: Bool
  let comingSoon: Bool
  @Binding var enabled: Bool

  /// Init from a CapabilityItem (metadata) + external enabled binding.
  init(item: CapabilityItem, enabled: Binding<Bool>) {
    self.icon = item.meta.icon
    self.tint = capabilityTint(item.meta.color)
    self.name = item.meta.name
    self.description = item.meta.description
    self.isUserPlugin = item.isUserPlugin
    self.comingSoon = item.meta.comingSoon == true
    self._enabled = enabled
  }

  /// Explicit init for custom rows (e.g. browser).
  init(icon: String, tint: Color, name: String, description: String,
       enabled: Binding<Bool>) {
    self.icon = icon
    self.tint = tint
    self.name = name
    self.description = description
    self.isUserPlugin = false
    self.comingSoon = false
    self._enabled = enabled
  }

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(tint)
          .frame(width: 28, height: 28)
        Image(systemName: icon)
          .font(.system(size: 14, weight: .medium))
          .foregroundColor(.white)
      }

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(name).font(.body)
          if isUserPlugin {
            Text("插件")
              .font(.caption2).fontWeight(.medium)
              .padding(.horizontal, 5).padding(.vertical, 2)
              .background(Color.purple.opacity(0.12))
              .foregroundColor(.purple)
              .cornerRadius(4)
          }
          if comingSoon {
            Text("即将上线")
              .font(.caption2).fontWeight(.medium)
              .padding(.horizontal, 5).padding(.vertical, 2)
              .background(Color.secondary.opacity(0.15))
              .foregroundColor(.secondary)
              .cornerRadius(4)
          }
        }
        Text(description)
          .font(.caption).foregroundColor(.secondary)
      }

      Spacer()

      Toggle("", isOn: $enabled)
        .toggleStyle(.switch)
        .controlSize(.small)
        .disabled(comingSoon)
        .labelsHidden()
    }
    .padding(.vertical, 2)
  }
}

// MARK: - Capability Detail View (generic)

/// A simple detail page for capabilities that have no special config.
/// Receives the same `Binding<Bool>` from the parent's `enabledStates` dictionary,
/// so the toggle here and on the list row stay in sync without mutating the items array.
private struct CapabilityDetailView: View {
  let item: CapabilityItem
  @Binding var enabled: Bool

  private var tint: Color { capabilityTint(item.meta.color) }

  var body: some View {
    Form {
      Section {
        HStack(spacing: 14) {
          ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .fill(tint)
              .frame(width: 44, height: 44)
            Image(systemName: item.meta.icon)
              .font(.system(size: 22, weight: .medium))
              .foregroundColor(.white)
          }

          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Text(item.meta.name)
                .font(.headline)
              if item.isUserPlugin {
                Text("插件")
                  .font(.caption2).fontWeight(.medium)
                  .padding(.horizontal, 5).padding(.vertical, 2)
                  .background(Color.purple.opacity(0.12))
                  .foregroundColor(.purple)
                  .cornerRadius(4)
              }
            }
            Text(item.meta.description)
              .font(.subheadline).foregroundColor(.secondary)
          }
        }
        .padding(.vertical, 4)
      }

      Section {
        Toggle("启用", isOn: $enabled)
          .disabled(item.meta.comingSoon == true)
      } footer: {
        Text("开关变更将在 Agent 重启后生效。")
      }

      Section {
        LabeledContent("类型") {
          Text(item.isUserPlugin ? "用户插件" : "内置能力")
        }
        LabeledContent("标识") {
          Text(item.id).font(.system(.body, design: .monospaced))
        }
      } header: {
        Text("信息")
      }
    }
    .formStyle(.grouped)
  }
}

// MARK: - Helpers

private func directorySize(_ url: URL) -> Int64 {
  var total: Int64 = 0
  guard let enumerator = FileManager.default.enumerator(
    at: url,
    includingPropertiesForKeys: [.fileSizeKey],
    options: [.skipsHiddenFiles, .skipsPackageDescendants]
  ) else { return 0 }
  for case let fileURL as URL in enumerator {
    total += Int64((try? fileURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
  }
  return total
}
