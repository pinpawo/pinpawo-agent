import SwiftUI

struct LLMSettingsView: View {
  @EnvironmentObject private var appState: AppState

  @State private var apiKey = ""
  @State private var baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1"
  @State private var model = "qwen-plus"
  @State private var errorMsg: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Image(systemName: "cpu").foregroundColor(.accentColor)
        Text("配置 LLM").font(.headline)
      }

      Text("配置用于生成宠物内容的 AI 模型（支持 OpenAI 兼容接口）")
        .font(.caption)
        .foregroundColor(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      Divider()

      field(label: "API Key", placeholder: "sk-...", text: $apiKey, secure: true)
      field(label: "Base URL", placeholder: baseUrl, text: $baseUrl)
      field(label: "Model", placeholder: model, text: $model)

      if let err = errorMsg {
        Text(err).font(.caption).foregroundColor(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      Button("保存并继续") { save() }
        .buttonStyle(.borderedProminent)
        .frame(maxWidth: .infinity)
        .disabled(apiKey.isEmpty)

      Divider()
      HStack {
        Spacer()
        Button("退出登录") { appState.logout() }
          .buttonStyle(.plain).font(.caption).foregroundColor(.secondary)
      }
    }
    .padding(16)
    .frame(width: 300)
    .onAppear {
      let c = Config.shared.load()
      apiKey = c.llmApiKey ?? ""
      baseUrl = c.llmBaseUrl
      model = c.llmModel
    }
  }

  private func field(label: String, placeholder: String, text: Binding<String>, secure: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption).foregroundColor(.secondary)
      Group {
        if secure {
          SecureField(placeholder, text: text)
        } else {
          TextField(placeholder, text: text)
        }
      }
      .textFieldStyle(.plain)
      .padding(8)
      .background(Color(nsColor: .controlBackgroundColor))
      .cornerRadius(6)
    }
  }

  private func save() {
    let key = apiKey.trimmingCharacters(in: .whitespaces)
    guard !key.isEmpty else { errorMsg = "API Key 不能为空"; return }
    Config.shared.update {
      $0.llmApiKey = key
      $0.llmBaseUrl = baseUrl.isEmpty ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : baseUrl
      $0.llmModel = model.isEmpty ? "qwen-plus" : model
    }
    appState.advance()
  }
}
