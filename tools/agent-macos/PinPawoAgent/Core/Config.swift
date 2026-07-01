import Foundation

struct AgentConfig: Codable {
  var apiBaseUrl: String
  var hasuraEndpoint: String
  var agentToken: String?
  var hasuraJwt: String?
  var userId: String?
  var nickname: String?
  var actorId: String?
  var actorName: String?
  var llmApiKey: String?
  var llmBaseUrl: String
  var llmModel: String
  var agentDistPath: String?   // override for dev: path to dist/index.js
  var browserBackend: String?  // nil/"auto" | "playwright"
  var workdir: String?         // agent working directory for relative paths; nil = homedir
  var globalReviewPolicy: String? // nil/"require_authorization" | "auto_authorization" | "full_access"
  /// Per-capability enabled/disabled overrides.  Absent key = defaultEnabled from manifest.
  var capabilities: [String: Bool]?
  /// Enable thinking/reasoning for subagent calls. Default: false.
  var subagentThinking: Bool?
  /// Extra directories to scan for user-defined capability plugins (beyond ~/.pinpawo/capabilities/).
  var capabilityDirs: [String]?

  enum CodingKeys: String, CodingKey {
    case apiBaseUrl = "api_base_url"
    case hasuraEndpoint = "hasura_endpoint"
    case agentToken = "agent_token"
    case hasuraJwt = "hasura_jwt"
    case userId = "user_id"
    case nickname
    case actorId = "actor_id"
    case actorName = "actor_name"
    case llmApiKey = "llm_api_key"
    case llmBaseUrl = "llm_base_url"
    case llmModel = "llm_model"
    case agentDistPath = "agent_dist_path"
    case browserBackend = "browser_backend"
    case workdir
    case globalReviewPolicy = "global_review_policy"
    case subagentThinking = "subagent_thinking"
    case capabilities
    case capabilityDirs = "capability_dirs"
  }

  enum LegacyCodingKeys: String, CodingKey {
    case reviewPolicyStrategy = "review_policy_strategy"
  }

  init(
    apiBaseUrl: String, hasuraEndpoint: String,
    agentToken: String?, hasuraJwt: String?,
    userId: String?, nickname: String?, actorId: String?,
    llmApiKey: String?, llmBaseUrl: String, llmModel: String,
    agentDistPath: String? = nil, browserBackend: String? = nil, workdir: String? = nil,
    globalReviewPolicy: String? = nil,
    subagentThinking: Bool? = nil,
    capabilities: [String: Bool]? = nil,
    capabilityDirs: [String]? = nil,
    actorName: String? = nil
  ) {
    self.apiBaseUrl = apiBaseUrl
    self.hasuraEndpoint = hasuraEndpoint
    self.agentToken = agentToken
    self.hasuraJwt = hasuraJwt
    self.userId = userId
    self.nickname = nickname
    self.actorId = actorId
    self.llmApiKey = llmApiKey
    self.llmBaseUrl = llmBaseUrl
    self.llmModel = llmModel
    self.agentDistPath = agentDistPath
    self.browserBackend = browserBackend
    self.workdir = workdir
    self.globalReviewPolicy = globalReviewPolicy
    self.subagentThinking = subagentThinking
    self.capabilities = capabilities
    self.capabilityDirs = capabilityDirs
    self.actorName = actorName
  }

  // Custom decode: missing fields fall back to defaults so login state survives
  // even when the JSON was written by an older version or the TypeScript agent.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let legacy = try decoder.container(keyedBy: LegacyCodingKeys.self)
    apiBaseUrl      = try c.decodeIfPresent(String.self, forKey: .apiBaseUrl)      ?? "https://a.ai.hughub.cn"
    hasuraEndpoint  = try c.decodeIfPresent(String.self, forKey: .hasuraEndpoint)  ?? ""
    agentToken      = try c.decodeIfPresent(String.self, forKey: .agentToken)
    hasuraJwt       = try c.decodeIfPresent(String.self, forKey: .hasuraJwt)
    userId          = try c.decodeIfPresent(String.self, forKey: .userId)
    nickname        = try c.decodeIfPresent(String.self, forKey: .nickname)
    actorId         = try c.decodeIfPresent(String.self, forKey: .actorId)
    llmApiKey       = try c.decodeIfPresent(String.self, forKey: .llmApiKey)
    llmBaseUrl      = try c.decodeIfPresent(String.self, forKey: .llmBaseUrl)      ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
    llmModel        = try c.decodeIfPresent(String.self, forKey: .llmModel)        ?? "qwen3.5-plus"
    agentDistPath   = try c.decodeIfPresent(String.self, forKey: .agentDistPath)
    browserBackend  = try c.decodeIfPresent(String.self, forKey: .browserBackend)
    workdir         = try c.decodeIfPresent(String.self, forKey: .workdir)
    globalReviewPolicy = try c.decodeIfPresent(String.self, forKey: .globalReviewPolicy)
      ?? legacy.decodeIfPresent(String.self, forKey: .reviewPolicyStrategy)
    subagentThinking = try c.decodeIfPresent(Bool.self, forKey: .subagentThinking)
    capabilities    = try c.decodeIfPresent([String: Bool].self, forKey: .capabilities)
    capabilityDirs  = try c.decodeIfPresent([String].self, forKey: .capabilityDirs)
    actorName       = try c.decodeIfPresent(String.self, forKey: .actorName)
  }

  static let `default` = AgentConfig(
    apiBaseUrl: "https://a.ai.hughub.cn",
    hasuraEndpoint: "",
    agentToken: nil,
    hasuraJwt: nil,
    userId: nil,
    nickname: nil,
    actorId: nil,
    llmApiKey: nil,
    llmBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    llmModel: "qwen3.5-plus",
    agentDistPath: nil
  )
}

final class Config {
  static let shared = Config()

  private let configURL: URL
  /// Serialises all read-modify-write cycles so concurrent `update()` calls
  /// cannot lose writes.
  private let lock = NSLock()

  private let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.prettyPrinted, .sortedKeys]
    return e
  }()

  private init() {
    let dir = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".pinpawo")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    configURL = dir.appendingPathComponent("config.json")
  }

  func load() -> AgentConfig {
    lock.lock()
    defer { lock.unlock() }
    return loadUnsafe()
  }

  func save(_ config: AgentConfig) {
    lock.lock()
    defer { lock.unlock() }
    saveUnsafe(config)
  }

  func update(_ transform: (inout AgentConfig) -> Void) {
    lock.lock()
    defer { lock.unlock() }
    var config = loadUnsafe()
    transform(&config)
    saveUnsafe(config)
  }

  var isLoggedIn: Bool { load().agentToken != nil }
  var hasLlmConfig: Bool { !(load().llmApiKey ?? "").isEmpty }
  var hasActor: Bool { !(load().actorId ?? "").isEmpty }

  // MARK: - Internal (caller must hold lock)

  private func loadUnsafe() -> AgentConfig {
    guard
      let data = try? Data(contentsOf: configURL),
      let config = try? JSONDecoder().decode(AgentConfig.self, from: data)
    else { return .default }
    return config
  }

  private func saveUnsafe(_ config: AgentConfig) {
    guard let data = try? encoder.encode(config) else { return }
    try? data.write(to: configURL, options: .atomic)
  }
}
