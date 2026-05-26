import SwiftUI

struct ActorMissingView: View {
  @EnvironmentObject private var appState: AppState

  @State private var actors: [Actor] = []
  @State private var loading = false
  @State private var errorMsg: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Image(systemName: "pawprint.fill").foregroundColor(.accentColor)
        Text("选择宠物角色").font(.headline)
      }

      Divider()

      if loading {
        HStack {
          ProgressView().scaleEffect(0.8)
          Text("加载中…").font(.caption).foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
      } else if let err = errorMsg {
        Text(err).font(.caption).foregroundColor(.red)
          .fixedSize(horizontal: false, vertical: true)
        Button("重试") { Task { await loadActors() } }
          .buttonStyle(.bordered).controlSize(.small)
      } else if actors.isEmpty {
        VStack(spacing: 8) {
          Image(systemName: "tray").font(.title2).foregroundColor(.secondary)
          Text("未找到宠物，请先在 PinPawo App 中创建一只宠物。")
            .font(.caption).foregroundColor(.secondary)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
      } else {
        VStack(spacing: 6) {
          ForEach(actors) { actor in
            Button(action: { select(actor) }) {
              HStack {
                VStack(alignment: .leading, spacing: 2) {
                  Text(actor.name).font(.body)
                  if let species = actor.species {
                    Text(species + (actor.stage.map { " · \($0)" } ?? ""))
                      .font(.caption).foregroundColor(.secondary)
                  }
                }
                Spacer()
                Image(systemName: "chevron.right")
                  .font(.caption).foregroundColor(.secondary)
              }
              .padding(8)
              .background(Color(nsColor: .controlBackgroundColor))
              .cornerRadius(6)
            }
            .buttonStyle(.plain)
          }
        }
      }

      Divider()
      HStack {
        Button("刷新") { Task { await loadActors() } }
          .buttonStyle(.plain).font(.caption).foregroundColor(.secondary)
        Spacer()
        Button("退出登录") { appState.logout() }
          .buttonStyle(.plain).font(.caption).foregroundColor(.secondary)
      }
    }
    .padding(16)
    .frame(width: 280)
    .task { await loadActors() }
  }

  // MARK: - Data

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

  private func select(_ actor: Actor) {
    Config.shared.update { $0.actorId = actor.id; $0.actorName = actor.name }
    appState.advance()
  }

}
