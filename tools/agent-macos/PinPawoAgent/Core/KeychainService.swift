import Foundation
import Security

final class KeychainService {
  static let shared = KeychainService()

  private let service = "app.pinpawo.agent"

  func save(_ value: String, forKey key: String) {
    guard let data = value.data(using: .utf8) else { return }
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
    ]
    SecItemDelete(query as CFDictionary)
    var attrs = query
    attrs[kSecValueData] = data
    SecItemAdd(attrs as CFDictionary, nil)
  }

  func load(forKey key: String) -> String? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data,
          let string = String(data: data, encoding: .utf8)
    else { return nil }
    return string
  }

  func delete(forKey key: String) {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: key,
    ]
    SecItemDelete(query as CFDictionary)
  }
}

extension KeychainService {
  var agentToken: String? {
    get { load(forKey: "agent_token") }
    set {
      if let v = newValue { save(v, forKey: "agent_token") }
      else { delete(forKey: "agent_token") }
    }
  }

  var userPhone: String? {
    get { load(forKey: "user_phone") }
    set {
      if let v = newValue { save(v, forKey: "user_phone") }
      else { delete(forKey: "user_phone") }
    }
  }

  var userNickname: String? {
    get { load(forKey: "user_nickname") }
    set {
      if let v = newValue { save(v, forKey: "user_nickname") }
      else { delete(forKey: "user_nickname") }
    }
  }
}
