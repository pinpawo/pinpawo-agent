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
  let activeOperationKind: String?
  let activeOperationTitle: String?
  let activeOperationTarget: String?
  let activeOperationSummary: String?
  let activeOperationPhase: String?
  let activeOperationEventId: Int?
  let activeOperationUpdatedAt: String?
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
    case activeOperationKind = "active_operation_kind"
    case activeOperationTitle = "active_operation_title"
    case activeOperationTarget = "active_operation_target"
    case activeOperationSummary = "active_operation_summary"
    case activeOperationPhase = "active_operation_phase"
    case activeOperationEventId = "active_operation_event_id"
    case activeOperationUpdatedAt = "active_operation_updated_at"
    case agentRunPhase = "agent_run_phase"
    case agentRunRequestId = "agent_run_request_id"
    case agentRunUpdatedAt = "agent_run_updated_at"
  }
}
