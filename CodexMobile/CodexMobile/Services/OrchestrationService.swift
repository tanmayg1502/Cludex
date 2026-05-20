// FILE: OrchestrationService.swift
// Purpose: Sends orchestration/start RPC and tracks per-step progress from bridge notifications.
// Layer: Service
// Exports: OrchestrationService
// Depends on: Foundation, Observation, CodexService, OrchestrationPlan, JSONValue

import Foundation
import Observation

@MainActor
@Observable
final class OrchestrationService {

    // MARK: - Public state

    private(set) var activeRunId: String?
    private(set) var activePlan: OrchestrationPlan?
    private(set) var stepStates: [Int: OrchestrationStepState] = [:]
    private(set) var lastError: String?
    private(set) var isRunFinished = false

    // MARK: - Start

    /// Sends `orchestration/start` and returns the bridge-assigned orchestrationId.
    func startOrchestration(_ plan: OrchestrationPlan, via codex: CodexService) async throws -> String {
        reset()
        activePlan = plan
        isRunFinished = false

        // Encode steps as a JSON array
        let stepsValue: JSONValue = .array(plan.steps.enumerated().map { index, step in
            var fields: [String: JSONValue] = [
                "agentId": .string(step.agentId),
                "model": .string(step.model),
                "role": .string(step.role),
            ]
            if !step.prompt.isEmpty {
                fields["prompt"] = .string(step.prompt)
            }
            return .object(fields)
        })

        var params: [String: JSONValue] = [
            "planId": .string(plan.id.uuidString),
            "steps": stepsValue,
        ]
        if !plan.title.isEmpty {
            params["title"] = .string(plan.title)
        }
        if let cwd = plan.cwd, !cwd.isEmpty {
            params["cwd"] = .string(cwd)
        }

        let response = try await codex.sendRequest(
            method: "orchestration/start",
            params: .object(params)
        )

        guard let result = response.result?.objectValue,
              let orchestrationId = result["orchestrationId"]?.stringValue else {
            throw OrchestrationServiceError.invalidResponse("orchestration/start missing orchestrationId")
        }

        activeRunId = orchestrationId

        // Seed all steps as pending
        for index in plan.steps.indices {
            stepStates[index] = .pending
        }

        return orchestrationId
    }

    // MARK: - Notification handler

    /// Called from CodexService+Incoming for any `orchestration/*` method.
    func handleOrchestrationNotification(method: String, params: JSONValue?) {
        let p = params?.objectValue ?? [:]
        let notificationRunId = p["orchestrationId"]?.stringValue

        switch method {
        case "orchestration/started":
            guard activePlan != nil else { return }
            if let id = notificationRunId {
                guard activeRunId == nil || activeRunId == id else { return }
                activeRunId = id
                isRunFinished = false
            }

        case "orchestration/step/started":
            guard acceptsNotification(for: notificationRunId) else { return }
            guard let index = stepIndex(from: p) else { return }
            let threadId = p["threadId"]?.stringValue ?? ""
            stepStates[index] = .running(threadId: threadId)

        case "orchestration/step/completed":
            guard acceptsNotification(for: notificationRunId) else { return }
            guard let index = stepIndex(from: p) else { return }
            let threadId = p["threadId"]?.stringValue ?? stepStates[index]?.threadId ?? ""
            let summary = p["summary"]?.stringValue ?? ""
            stepStates[index] = .completed(threadId: threadId, summary: summary)

        case "orchestration/completed":
            guard acceptsNotification(for: notificationRunId) else { return }
            // Mark any still-pending/running steps as completed on the top-level signal
            for key in stepStates.keys {
                if case .running(let tid) = stepStates[key] {
                    stepStates[key] = .completed(threadId: tid, summary: "")
                }
            }
            isRunFinished = true

        case "orchestration/failed":
            guard acceptsNotification(for: notificationRunId) else { return }
            let error = p["error"]?.stringValue ?? "Orchestration failed"
            lastError = error
            // Mark any in-progress step as failed
            for key in stepStates.keys {
                if case .running = stepStates[key] {
                    stepStates[key] = .failed(error: error)
                }
            }
            isRunFinished = true

        default:
            break
        }
    }

    // MARK: - Reset

    func reset() {
        activeRunId = nil
        activePlan = nil
        stepStates = [:]
        lastError = nil
        isRunFinished = false
    }

    // MARK: - Helpers

    private func stepIndex(from params: [String: JSONValue]) -> Int? {
        if let v = params["stepIndex"]?.intValue { return v }
        if let v = params["stepIndex"]?.stringValue { return Int(v) }
        return nil
    }

    private func acceptsNotification(for runId: String?) -> Bool {
        guard let activeRunId else { return false }
        guard let runId, !runId.isEmpty else { return false }
        return runId == activeRunId
    }
}

// MARK: - Error

enum OrchestrationServiceError: LocalizedError {
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse(let msg): return msg
        }
    }
}
