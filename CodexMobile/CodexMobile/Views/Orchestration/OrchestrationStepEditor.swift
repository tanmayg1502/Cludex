// FILE: OrchestrationStepEditor.swift
// Purpose: Single-step editor row for an OrchestrationComposerSheet.
// Layer: View Component
// Exports: OrchestrationStepEditor
// Depends on: SwiftUI, OrchestrationPlan, AppFont

import SwiftUI

// MARK: - Agent / model catalogue

private enum OrchestrationAgentOption: String, CaseIterable, Identifiable {
    case claudeCode = "claude-code"
    case codex = "codex"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude"
        case .codex: return "Codex"
        }
    }
}

struct OrchestrationModelOption: Identifiable, Equatable {
    let id: String
    let label: String
}

// Pulls the live model/list result that the rest of the app uses for chats,
// so orchestration never offers a model the user's account doesn't accept.
private func orchestrationModels(
    for agent: OrchestrationAgentOption,
    from availableModels: [CodexModelOption]
) -> [OrchestrationModelOption] {
    let normalizedModels = availableModels.map { option -> (CodexModelOption, Bool) in
        let isClaude = option.model.lowercased().hasPrefix("claude")
            || option.id.lowercased().hasPrefix("claude")
        return (option, isClaude)
    }

    let filtered: [CodexModelOption]
    switch agent {
    case .claudeCode:
        filtered = normalizedModels.filter { $0.1 }.map { $0.0 }
    case .codex:
        filtered = normalizedModels.filter { !$0.1 }.map { $0.0 }
    }

    return filtered.map { option in
        let label = option.displayName.isEmpty ? option.model : option.displayName
        return OrchestrationModelOption(id: option.id.isEmpty ? option.model : option.id, label: label)
    }
}

private let predefinedRoles: [String] = ["planner", "implementer", "reviewer"]

// MARK: - View

struct OrchestrationStepEditor: View {
    let stepIndex: Int
    @Binding var step: OrchestrationStep
    let canRemove: Bool
    let onRemove: () -> Void

    @Environment(CodexService.self) private var codex

    // Derived agent for picker binding
    private var selectedAgent: OrchestrationAgentOption {
        OrchestrationAgentOption(rawValue: step.agentId) ?? .claudeCode
    }

    private var modelsForSelectedAgent: [OrchestrationModelOption] {
        orchestrationModels(for: selectedAgent, from: codex.availableModels)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header: step number + remove button
            HStack {
                Text("Step \(stepIndex + 1)")
                    .font(AppFont.subheadline(weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                if canRemove {
                    Button(role: .destructive) {
                        onRemove()
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .foregroundStyle(.red)
                            .font(.system(size: 18))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove step \(stepIndex + 1)")
                }
            }

            // Agent picker
            agentRow

            // Model picker
            modelRow

            // Role field
            roleRow

            // Prompt field (step 0 required; later steps optional)
            promptRow
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Agent

    private var agentRow: some View {
        HStack {
            Text("Agent")
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 68, alignment: .leading)
            Picker("Agent", selection: Binding(
                get: { selectedAgent },
                set: { newAgent in
                    step.agentId = newAgent.rawValue
                    // Reset model to first valid choice for new agent
                    let firstModel = orchestrationModels(for: newAgent, from: codex.availableModels).first?.id
                    step.model = firstModel ?? step.model
                }
            )) {
                ForEach(OrchestrationAgentOption.allCases) { option in
                    Text(option.displayName).tag(option)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Model

    private var modelRow: some View {
        HStack {
            Text("Model")
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 68, alignment: .leading)
            Picker("Model", selection: $step.model) {
                ForEach(modelsForSelectedAgent) { option in
                    Text(option.label).tag(option.id)
                }
            }
            .pickerStyle(.menu)
            .tint(.accentColor)
        }
    }

    // MARK: - Role

    private var roleRow: some View {
        HStack(alignment: .center) {
            Text("Role")
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 68, alignment: .leading)
            // Inline quick-picks + free-text field
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(predefinedRoles, id: \.self) { role in
                        Button {
                            step.role = role
                        } label: {
                            Text(role)
                                .font(AppFont.caption(weight: .medium))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(
                                    step.role == role
                                        ? Color.accentColor.opacity(0.15)
                                        : Color(.tertiarySystemGroupedBackground),
                                    in: Capsule()
                                )
                                .foregroundStyle(step.role == role ? Color.accentColor : .secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            TextField("custom", text: $step.role)
                .font(AppFont.footnote())
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(maxWidth: 90)
                .multilineTextAlignment(.trailing)
        }
    }

    // MARK: - Prompt

    private var promptRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Prompt")
                    .font(AppFont.footnote(weight: .medium))
                    .foregroundStyle(.secondary)
                if stepIndex == 0 {
                    Text("required")
                        .font(AppFont.caption())
                        .foregroundStyle(.red.opacity(0.7))
                } else {
                    Text("optional")
                        .font(AppFont.caption())
                        .foregroundStyle(.tertiary)
                }
            }
            TextEditor(text: $step.prompt)
                .font(AppFont.footnote())
                .frame(minHeight: 64, maxHeight: 120)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}
