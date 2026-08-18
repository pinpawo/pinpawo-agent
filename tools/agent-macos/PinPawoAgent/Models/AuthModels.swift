import Foundation

// MARK: - Actor (pet picker)

struct Actor: Identifiable {
  let id: String
  let name: String
  let species: String?
  let stage: String?
}

/// Fetch all pets owned by the current user via user_pets.
/// Hasura JWT row-level security automatically scopes to the authenticated user.
func fetchActors() async throws -> [Actor] {
  let config = Config.shared.load()
  guard let jwt = config.hasuraJwt, let endpoint = URL(string: config.hasuraEndpoint) else {
    throw NSError(domain: "ActorPicker", code: 0,
                  userInfo: [NSLocalizedDescriptionKey: "Hasura 未配置，请重新登录"])
  }

  let query = """
  { "query": "query { user_pets(order_by: [{ is_primary: desc }, { created_at: desc }]) { pet { id name template { species } pet_state { stage } } } }" }
  """

  var req = URLRequest(url: endpoint)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
  req.httpBody = query.data(using: .utf8)

  let (data, response) = try await URLSession.shared.data(for: req)
  if let http = response as? HTTPURLResponse, http.statusCode != 200 {
    throw NSError(domain: "ActorPicker", code: http.statusCode,
                  userInfo: [NSLocalizedDescriptionKey: "请求失败 (\(http.statusCode))"])
  }

  guard
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let dataObj = json["data"] as? [String: Any],
    let userPets = dataObj["user_pets"] as? [[String: Any]]
  else {
    throw NSError(domain: "ActorPicker", code: 0,
                  userInfo: [NSLocalizedDescriptionKey: "响应解析失败"])
  }

  var seen = Set<String>()
  return userPets.compactMap { row -> Actor? in
    guard let pet = row["pet"] as? [String: Any],
          let id = pet["id"] as? String,
          !seen.contains(id)
    else { return nil }
    seen.insert(id)
    let template = pet["template"] as? [String: Any]
    let petState = pet["pet_state"] as? [String: Any]
    return Actor(
      id: id,
      name: pet["name"] as? String ?? id,
      species: template?["species"] as? String,
      stage: petState?["stage"] as? String
    )
  }
}

