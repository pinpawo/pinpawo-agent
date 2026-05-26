import SwiftUI

struct StatusView: View {
  @EnvironmentObject private var appState: AppState
  @Environment(\.openWindow) private var openWindow
  @State private var showLogs = false

  private var poller: StatusPoller { appState.poller }
  private var agent: AgentProcess { appState.agent }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      headerSection
      Divider()
      healthSection
      if let err = agent.errorMessage {
        Text(err)
          .font(.caption).foregroundColor(.red)
          .padding(.horizontal, 16).padding(.bottom, 8)
          .fixedSize(horizontal: false, vertical: true)
      }
      Divider()
      controlsSection
      Divider()
      footerSection
    }
    .frame(width: 300)
  }

  // MARK: - Sections

  private var headerSection: some View {
    HStack {
      Image(systemName: "pawprint.fill").foregroundColor(.accentColor)
      Text("PinPawo Agent").font(.headline)
      Spacer()
      HStack(spacing: 4) {
        Circle()
          .fill(agent.isRunning ? Color.green : Color.gray)
          .frame(width: 7, height: 7)
        Text(agent.isRunning ? "运行中" : "已停止")
          .font(.caption).foregroundColor(.secondary)
      }
      Button {
        openWindow(id: "settings")
        SettingsWindowFocus.bringToFront()
      } label: {
        Image(systemName: "gearshape").font(.subheadline)
      }
      .buttonStyle(.plain)
      .foregroundColor(.secondary)
      .help("设置")
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
  }

  @ViewBuilder
  private var healthSection: some View {
    if let h = poller.health {
      VStack(alignment: .leading, spacing: 6) {
        if h.actorId != nil {
          infoRow(label: "角色", value: h.actorName ?? Config.shared.load().actorName ?? h.actorId!)
        }
        if let lastRunAt = h.lastRunAt {
          infoRow(
            label: "上次运行",
            value: (h.lastRunOk == true ? "✓ " : "✗ ") + relativeAgo(lastRunAt),
            valueColor: h.lastRunOk == true ? .primary : .red
          )
        }
        if let total = h.totalRuns {
          let ok = h.successfulRuns ?? 0
          infoRow(label: "总计", value: "\(total) 次 (\(ok) 成功)")
        }
        if let mode = h.browserMode {
          let label = mode == "playwright"
            ? "Playwright"
            : mode == "agent-browser"
              ? "Agent Browser"
              : "未启用"
          let detail = (h.browserDetail?.isEmpty == false && mode == "none")
            ? " · \(h.browserDetail!)"
            : ""
          infoRow(label: "浏览器", value: label + detail, valueColor: mode == "none" ? .secondary : .primary)
        }
      }
      .padding(.horizontal, 16).padding(.vertical, 10)
    } else if agent.isRunning {
      HStack {
        ProgressView().scaleEffect(0.7)
        Text("正在连接…").font(.caption).foregroundColor(.secondary)
      }
      .padding(.horizontal, 16).padding(.vertical, 10)
    } else {
      Text("服务未启动")
        .font(.caption).foregroundColor(.secondary)
        .padding(.horizontal, 16).padding(.vertical, 10)
    }
  }

  private var controlsSection: some View {
    HStack(spacing: 8) {
      if agent.isRunning {
        Button("停止服务") { appState.stopAgent() }
          .buttonStyle(.bordered).controlSize(.small)
      } else if agent.isStarting {
        HStack(spacing: 6) {
          ProgressView().scaleEffect(0.7).frame(width: 14, height: 14)
          Text("启动中…").font(.caption).foregroundColor(.secondary)
        }
      } else {
        Button("启动服务") {
          showLogs = true
          appState.startAgent()
        }
        .buttonStyle(.borderedProminent).controlSize(.small)
      }
      Spacer()
      Button {
        appState.showDesktopPet()
      } label: {
        Image(systemName: appState.desktopPetVisible ? "pawprint.circle.fill" : "pawprint.circle")
          .font(.subheadline)
      }
      .buttonStyle(.plain)
      .foregroundColor(appState.desktopPetVisible ? .accentColor : .secondary)
      .help("显示/定位桌面宠物")

      Button(showLogs ? "隐藏日志" : "日志") { showLogs.toggle() }
        .buttonStyle(.plain).font(.caption).foregroundColor(.secondary)
    }
    .padding(.horizontal, 16).padding(.vertical, 10)
  }

  @ViewBuilder
  private var footerSection: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        if let nickname = Config.shared.load().nickname {
          Text(nickname).font(.caption).lineLimit(1)
        }
      }
      Spacer()
      Button("退出登录") { appState.logout() }
        .buttonStyle(.plain).font(.caption).foregroundColor(.secondary)
      Divider().frame(height: 12)
      Toggle("开机启动", isOn: Binding(
        get: { appState.launchAtLogin },
        set: { _ in appState.toggleLaunchAtLogin() }
      ))
      .toggleStyle(.checkbox).font(.caption)
      Divider().frame(height: 12)
      Button("退出") { NSApplication.shared.terminate(nil) }
        .buttonStyle(.plain).font(.caption).foregroundColor(.secondary)
    }
    .padding(.horizontal, 16).padding(.vertical, 10)

    if showLogs {
      Divider()
      HStack {
        Spacer()
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(agent.logs.joined(separator: "\n"), forType: .string)
        } label: {
          Label("复制日志", systemImage: "doc.on.doc")
            .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundColor(.secondary)
        .padding(.horizontal, 8)
        .padding(.top, 4)
      }
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(agent.logs.enumerated()), id: \.offset) { i, line in
              Text(line)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.secondary)
                .id(i)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
        }
        .frame(height: 120)
        .onChange(of: agent.logs.count) { _ in
          if let last = agent.logs.indices.last {
            proxy.scrollTo(last, anchor: .bottom)
          }
        }
      }
    }
  }

  // MARK: - Helpers

  private func infoRow(label: String, value: String, valueColor: Color = .primary) -> some View {
    HStack {
      Text(label).font(.caption).foregroundColor(.secondary).frame(width: 56, alignment: .leading)
      Text(value).font(.caption).foregroundColor(valueColor)
      Spacer()
    }
  }

  private func relativeAgo(_ isoString: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: isoString) ?? ISO8601DateFormatter().date(from: isoString) else {
      return isoString
    }
    let diff = -date.timeIntervalSinceNow
    if diff < 60 { return "刚刚" }
    let m = Int(diff) / 60
    if m < 60 { return "\(m)m 前" }
    return "\(m / 60)h 前"
  }
}
