// FILE: OrchestrationPlan.swift
// Purpose: Data model for a cross-agent orchestration plan and its runtime step states.
// Layer: Model
// Exports: OrchestrationStep, OrchestrationPlan, OrchestrationStepState
// Depends on: Foundation

import Foundation

struct OrchestrationStep: Identifiable, Codable, Equatable {
    var id = UUID()
    var agentId: String    // "codex" or "claude-code"
    var model: String      // model id, e.g. "claude-opus-4-7" or "gpt-5"
    var role: String       // "planner" | "implementer" | "reviewer" | custom
    var prompt: String     // initial prompt for step 0; may be empty for later steps
}

struct OrchestrationPlan: Identifiable, Codable, Equatable {
    var id = UUID()
    var title: String
    var cwd: String?       // optional working directory
    var steps: [OrchestrationStep]
}

// MARK: - Default template

extension OrchestrationPlan {
    static var defaultTemplate: OrchestrationPlan {
        OrchestrationPlan(
            title: "",
            cwd: nil,
            steps: [
                OrchestrationStep(
                    agentId: "claude-code",
                    model: "claude-opus-4-7",
                    role: "planner",
                    prompt: ""
                ),
                OrchestrationStep(
                    agentId: "codex",
                    model: "gpt-5",
                    role: "implementer",
                    prompt: ""
                ),
                OrchestrationStep(
                    agentId: "claude-code",
                    model: "claude-sonnet-4-6",
                    role: "reviewer",
                    prompt: ""
                ),
            ]
        )
    }
}

// MARK: - Per-step runtime state

enum OrchestrationStepState: Equatable {
    case pending
    case running(threadId: String)
    case completed(threadId: String, summary: String)
    case failed(error: String)

    var isTerminal: Bool {
        switch self {
        case .completed, .failed: return true
        default: return false
        }
    }

    var displayLabel: String {
        switch self {
        case .pending: return "Pending"
        case .running: return "Running..."
        case .completed: return "Completed"
        case .failed: return "Failed"
        }
    }

    var threadId: String? {
        switch self {
        case .running(let id), .completed(let id, _): return id
        default: return nil
        }
    }
}
