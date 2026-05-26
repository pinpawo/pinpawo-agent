import Foundation

enum AuthError: LocalizedError {
  case invalidURL(String)
  case networkError(String)
  case serverError(Int, String)
  case decodingError

  var errorDescription: String? {
    switch self {
    case .invalidURL(let url): return "无效的 API 地址: \(url)"
    case .networkError(let msg): return "网络错误: \(msg)"
    case .serverError(let code, let msg): return "服务器错误 \(code): \(msg)"
    case .decodingError: return "响应解析失败"
    }
  }
}

final class AuthService {
  static let shared = AuthService()

  private var apiUrl: String { Config.shared.load().apiBaseUrl }

  private func makeURL(_ path: String) throws -> URL {
    let raw = "\(apiUrl)\(path)"
    guard let url = URL(string: raw) else { throw AuthError.invalidURL(raw) }
    return url
  }

  // MARK: - Step 1: Request SMS

  func requestSMS(phone: String) async throws {
    let url = try makeURL("/auth/sms/request")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONEncoder().encode(["phone": phone])
    let (data, response) = try await URLSession.shared.data(for: req)
    try validateResponse(response, data: data)
  }

  // MARK: - Step 2: Verify SMS → tokens

  func verifySMS(phone: String, code: String) async throws -> AuthResponse {
    let url = try makeURL("/auth/sms/verify")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONEncoder().encode(["phone": phone, "code": code])
    let (data, response) = try await URLSession.shared.data(for: req)
    try validateResponse(response, data: data)
    guard let auth = try? JSONDecoder().decode(AuthResponse.self, from: data) else {
      throw AuthError.decodingError
    }
    return auth
  }

  // MARK: - Step 3: Issue long-lived agent token

  func issueAgentToken(accessToken: String) async throws -> AgentTokenResponse {
    let url = try makeURL("/local-agent/token")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    req.httpBody = try JSONEncoder().encode(["label": "macOS Agent"])
    let (data, response) = try await URLSession.shared.data(for: req)
    try validateResponse(response, data: data)
    guard let tokenResp = try? JSONDecoder().decode(AgentTokenResponse.self, from: data) else {
      throw AuthError.decodingError
    }
    return tokenResp
  }

  // MARK: - Full login flow

  func login(phone: String, code: String) async throws -> AuthUser {
    let auth = try await verifySMS(phone: phone, code: code)
    let tokenResp = try await issueAgentToken(accessToken: auth.accessToken)

    Config.shared.update {
      $0.agentToken = tokenResp.token
      $0.hasuraJwt = tokenResp.hasuraJwt
      $0.userId = auth.user.id
      $0.nickname = auth.user.nickname
    }

    return auth.user
  }

  func logout() {
    Config.shared.update {
      $0.agentToken = nil
      $0.hasuraJwt = nil
      $0.userId = nil
      $0.nickname = nil
      $0.actorId = nil
      $0.llmApiKey = nil
    }
  }

  // MARK: - Helpers

  private func validateResponse(_ response: URLResponse, data: Data) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard http.statusCode >= 200 && http.statusCode < 300 else {
      let msg = String(data: data, encoding: .utf8) ?? "unknown error"
      throw AuthError.serverError(http.statusCode, msg)
    }
  }
}
