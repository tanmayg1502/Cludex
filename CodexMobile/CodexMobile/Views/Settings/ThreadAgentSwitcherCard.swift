// FILE: ThreadAgentSwitcherCard.swift
// Purpose: Settings card that lets the user switch the agent and model on the currently-active thread.
// Layer: Settings UI component
// Exports: ThreadAgentSwitcherCard
// Depends on: SwiftUI, AppFont, CodexService, JSONValue

import SwiftUI

struct ThreadAgentSwitcherCard: View {
    let threadId: String

    @Environment(CodexService.self) private var codex

    @State private var selectedAgent: ThreadAgentSwitcherAgent = .codex
    @State private var selectedModel: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        SettingsCard(title: "Current Thread") {
            Picker("Agent", selection: $selectedAgent) {
                ForEach(ThreadAgentSwitcherAgent.allCases) { agent in
                    Text(agent.displayName).tag(agent)
                }
            }
            .pickerStyle(.menu)
            .tint(.primary)
            .onChange(of: selectedAgent) { _, newAgent in
                // Reset model to first available for the new agent when the agent changes.
                let models = availableModels(for: newAgent)
                if !models.isEmpty, !models.contains(where: { $0.model == selectedModel }) {
                    selectedModel = models.first?.model ?? selectedModel
                }
            }

            Picker("Model", selection: $selectedModel) {
                ForEach(availableModels(for: selectedAgent), id: \.model) { model in
                    Text(modelLabel(for: model)).tag(model.model)
                }
                if availableModels(for: selectedAgent).isEmpty {
                    Text(selectedAgent.fallbackModelLabel).tag(selectedModel)
                }
            }
            .pickerStyle(.menu)
            .tint(.primary)

            if let errorMessage {
                Text(errorMessage)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
            }

            SettingsButton(
                "Save changes",
                isLoading: isSaving
            ) {
                Task { await saveChanges() }
            }
            .disabled(isSaveDisabled)

            Text("Changes apply to new turns in this thread.")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
        }
        .task(id: threadId) {
            loadCurrentThreadValues()
        }
    }

    // MARK: - Derived state

    private var currentThread: CodexThread? {
        codex.threads.first(where: { $0.id == threadId })
    }

    private var isSaveDisabled: Bool {
        guard !isSaving else { return true }
        guard let thread = currentThread else { return true }
        let agentUnchanged = selectedAgent.rawValue == (thread.agentId ?? ThreadAgentSwitcherAgent.codex.rawValue)
        let modelUnchanged = selectedModel == (thread.model ?? "")
        return agentUnchanged && modelUnchanged
    }

    // MARK: - Model list

    private func availableModels(for agent: ThreadAgentSwitcherAgent) -> [CodexModelOption] {
        switch agent {
        case .codex:
            return codex.availableModels.filter { !$0.model.hasPrefix("claude-") }
        case .claude:
            return codex.availableModels.filter { $0.model.hasPrefix("claude-") }
        }
    }

    private func modelLabel(for model: CodexModelOption) -> String {
        model.displayName.isEmpty ? model.model : model.displayName
    }

    // MARK: - Load / save

    private func loadCurrentThreadValues() {
        guard let thread = currentThread else { return }
        selectedAgent = ThreadAgentSwitcherAgent.resolved(from: thread.agentId)
        selectedModel = thread.model ?? availableModels(for: selectedAgent).first?.model ?? ""
    }

    private func saveChanges() async {
        guard !isSaving else { return }
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }

        do {
            try await codex.updateThreadAgentAndModel(
                threadId: threadId,
                agentId: selectedAgent.rawValue,
                model: selectedModel
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - Agent enum

private enum ThreadAgentSwitcherAgent: String, CaseIterable, Identifiable {
    case codex = "codex"
    case claude = "claude-code"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .codex: return "Codex"
        case .claude: return "Claude"
        }
    }

    var fallbackModelLabel: String {
        switch self {
        case .codex: return "GPT-5.5"
        case .claude: return "Claude Sonnet"
        }
    }

    static func resolved(from agentId: String?) -> ThreadAgentSwitcherAgent {
        switch agentId?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case ThreadAgentSwitcherAgent.claude.rawValue:
            return .claude
        default:
            return .codex
        }
    }
}
