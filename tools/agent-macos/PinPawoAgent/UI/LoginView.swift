import SwiftUI

struct LoginView: View {
  @EnvironmentObject private var appState: AppState

  @State private var phone = ""
  @State private var code = ""
  @State private var smsSent = false
  @State private var loading = false
  @State private var errorMsg: String?
  @State private var countdown = 0
  @State private var countdownTimer: Timer?
  @State private var showAdvanced = false
  @State private var apiUrl = Config.shared.load().apiBaseUrl

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      // Header
      HStack {
        Image(systemName: "pawprint.fill")
          .foregroundColor(.accentColor)
        Text("PinPawo Agent")
          .font(.headline)
      }

      Divider()

      // Phone field
      VStack(alignment: .leading, spacing: 6) {
        Text("手机号").font(.caption).foregroundColor(.secondary)
        HStack {
          Text("+86").foregroundColor(.secondary).font(.body)
          TextField("请输入手机号", text: $phone)
            .textFieldStyle(.plain)
            .disabled(smsSent)
        }
        .padding(8)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(6)
      }

      // Code field (shown after SMS sent)
      if smsSent {
        VStack(alignment: .leading, spacing: 6) {
          Text("验证码").font(.caption).foregroundColor(.secondary)
          TextField("6 位验证码", text: $code)
            .textFieldStyle(.plain)
            .padding(8)
            .background(Color(nsColor: .controlBackgroundColor))
            .cornerRadius(6)
        }
      }

      // Error
      if let err = errorMsg {
        Text(err)
          .font(.caption)
          .foregroundColor(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      // Action button
      if !smsSent {
        Button(action: sendSMS) {
          HStack {
            if loading { ProgressView().scaleEffect(0.7) }
            Text("发送验证码")
          }
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(loading || phone.count < 11)
      } else {
        HStack(spacing: 8) {
          Button(action: verify) {
            HStack {
              if loading { ProgressView().scaleEffect(0.7) }
              Text("登录")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .disabled(loading || code.count != 6)

          Button(action: resend) {
            Text(countdown > 0 ? "\(countdown)s" : "重新发送")
          }
          .disabled(countdown > 0 || loading)
        }
      }

      // Advanced settings
      Divider()
      DisclosureGroup(isExpanded: $showAdvanced) {
        VStack(alignment: .leading, spacing: 6) {
          Text("API 地址").font(.caption).foregroundColor(.secondary)
          TextField("https://a.ai.hughub.cn", text: $apiUrl)
            .textFieldStyle(.plain)
            .font(.caption)
            .padding(6)
            .background(Color(nsColor: .controlBackgroundColor))
            .cornerRadius(6)
            .onChange(of: apiUrl) { v in
              Config.shared.update { $0.apiBaseUrl = v }
            }
        }
        .padding(.top, 6)
      } label: {
        Text("高级设置").font(.caption).foregroundColor(.secondary)
      }
    }
    .padding(16)
    .frame(width: 280)
  }

  // MARK: - Actions

  private func sendSMS() {
    loading = true
    errorMsg = nil
    Task {
      do {
        try await AuthService.shared.requestSMS(phone: "+86\(phone)")
        smsSent = true
        startCountdown()
      } catch {
        errorMsg = error.localizedDescription
      }
      loading = false
    }
  }

  private func verify() {
    loading = true
    errorMsg = nil
    Task {
      do {
        let user = try await AuthService.shared.login(phone: "+86\(phone)", code: code)
        appState.completeLogin(user: user)
      } catch {
        errorMsg = error.localizedDescription
      }
      loading = false
    }
  }

  private func resend() {
    code = ""
    errorMsg = nil
    sendSMS()
  }

  private func startCountdown() {
    countdown = 60
    countdownTimer?.invalidate()
    countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { timer in
      Task { @MainActor in
        countdown -= 1
        if countdown <= 0 {
          countdown = 0
          timer.invalidate()
        }
      }
    }
  }
}
