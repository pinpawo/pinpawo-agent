import Foundation

enum LocalServerAuth {
  private static var tokenURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".pinpawo/local-server-token")
  }

  static func token() -> String? {
    guard let raw = try? String(contentsOf: tokenURL, encoding: .utf8) else {
      return nil
    }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  static func authorize(_ request: inout URLRequest) {
    guard let token = token() else { return }
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  }
}
