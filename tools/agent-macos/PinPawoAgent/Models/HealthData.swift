import Foundation

struct HealthResponse: Codable {
  let status: String
  let actorId: String?
  let actorName: String?
  let startedAt: String?
  let totalRuns: Int?
  let successfulRuns: Int?
  let failedRuns: Int?
  let lastRunAt: String?
  let lastRunOk: Bool?
  let browserMode: String?
  let browserDetail: String?
  let activeToolName: String?
  let activeToolPhase: String?
  let activeToolEventId: Int?
  let activeToolUpdatedAt: String?
  let agentRunPhase: String?
  let agentRunRequestId: String?
  let agentRunUpdatedAt: String?

  enum CodingKeys: String, CodingKey {
    case status
    case actorId = "actor_id"
    case actorName = "actor_name"
    case startedAt = "started_at"
    case totalRuns = "total_runs"
    case successfulRuns = "successful_runs"
    case failedRuns = "failed_runs"
    case lastRunAt = "last_run_at"
    case lastRunOk = "last_run_ok"
    case browserMode = "browser_mode"
    case browserDetail = "browser_detail"
    case activeToolName = "active_tool_name"
    case activeToolPhase = "active_tool_phase"
    case activeToolEventId = "active_tool_event_id"
    case activeToolUpdatedAt = "active_tool_updated_at"
    case agentRunPhase = "agent_run_phase"
    case agentRunRequestId = "agent_run_request_id"
    case agentRunUpdatedAt = "agent_run_updated_at"
  }
}
