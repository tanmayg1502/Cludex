// FILE: OrchestrationComposerSheet.swift
// Purpose: Sheet for composing a 2-4 step orchestration plan, submitting it, and watching progress.
// Layer: View
// Exports: OrchestrationComposerSheet
// Depends on: SwiftUI, CodexService, OrchestrationService, OrchestrationPlan, AppFont

import SwiftUI

struct OrchestrationComposerSheet: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.dismiss) private var dismiss

    @State private var plan: OrchestrationPlan = .defaultTemplate
    @State private var isStarting = false
    @State private var startError: String?
    @State private var isCancelling = false

    // Forward to the service owned by CodexService so state survives sheet re-opens
    private var orchestrationService: OrchestrationService { codex.orchestrationService }

    // Transitions to progress view once a run is active
    private var isRunning: Bool { orchestrationService.activeRunId != nil }
    private var canCancelRun: Bool { isRunning && !orchestrationService.isRunFinished }
    private var progressPlan: OrchestrationPlan { orchestrationService.activePlan ?? plan }

    var body: some View {
        NavigationStack {
            Group {
                if isRunning {
                    progressContent
                } else {
                    composerContent
                }
            }
            .navigationTitle(isRunning ? "Orchestration" : "New Orchestration")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                    .tint(.secondary)
                    .disabled(isStarting)
                }

                if canCancelRun {
                    ToolbarItem(placement: .destructiveAction) {
                        cancelButton
                    }
                }

                if isRunning {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("New Plan") {
                            startNewPlan()
                        }
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Composer content

    private var composerContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Title
                titleSection

                // Working directory
                cwdSection

                // Steps
                stepsSection

                // Add step button
                if plan.steps.count < 4 {
                    addStepButton
                }

                // Error
                if let startError {
                    Text(startError)
                        .font(AppFont.footnote())
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                // CTA
                startButton
                    .padding(.bottom, 24)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var titleSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Title")
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Describe this orchestration run…", text: $plan.title)
                .font(AppFont.body())
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var cwdSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Working directory")
                .font(AppFont.footnote(weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Optional, e.g. /Users/you/myproject", text: Binding(
                get: { plan.cwd ?? "" },
                set: { plan.cwd = $0.isEmpty ? nil : $0 }
            ))
            .font(AppFont.mono(.caption))
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var stepsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Steps")        
                .font(AppFont.subheadline(weight: .semibold))
                .foregroundStyle(.primary)

            ForEach(plan.steps.indices, id: \.self) { index in
                OrchestrationStepEditor(
                    stepIndex: index,
                    step: $plan.steps[index],
                    canRemove: plan.steps.count > 2,
                    onRemove: {
                        withAnimation {
                            if plan.steps.indices.contains(index), plan.steps.count > 2 {
                                plan.steps.remove(at: index)
                            }
                        }
                    }
                )
            }
        }
    }

    private var addStepButton: some View {
        Button {
            withAnimation {
                plan.steps.append(
                    OrchestrationStep(
                        agentId: "claude-code",
                        model: "claude-sonnet-4-6",
                        role: "",
                        prompt: ""
                    )
                )
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle.fill")
                Text("Add step")
                    .font(AppFont.subheadline(weight: .medium))
            }
            .foregroundStyle(Color.accentColor)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    private var startButton: some View {
        Button {
            startOrchestration()
        } label: {
            Group {
                if isStarting {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Text("Start orchestration")
                        .font(AppFont.body(weight: .semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                canSubmit ? Color.accentColor : Color.accentColor.opacity(0.35),
                in: RoundedRectangle(cornerRadius: 12)
            )
            .foregroundStyle(Color.white)
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit || isStarting)
    }

    private var canSubmit: Bool {
        !plan.steps.isEmpty && !(plan.steps.first?.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    private func startOrchestration() {
        startError = nil
        isStarting = true
        Task { @MainActor in
            defer { isStarting = false }
            do {
                _ = try await orchestrationService.startOrchestration(plan, via: codex)
            } catch {
                startError = error.localizedDescription
            }
        }
    }

    // MARK: - Progress content

    private var progressContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Plan title
                if !progressPlan.title.isEmpty {
                    Text(progressPlan.title)
                        .font(AppFont.title3(weight: .semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal)
                        .padding(.top, 8)
                }

                // Overall error
                if let error = orchestrationService.lastError {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                        Text(error)
                            .font(AppFont.footnote())
                            .foregroundStyle(.red)
                    }
                    .padding()
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                }

                // Step rows
                ForEach(progressPlan.steps.indices, id: \.self) { index in
                    stepProgressRow(index: index, step: progressPlan.steps[index])
                }

                if isRunning {
                    Button {
                        startNewPlan()
                    } label: {
                        Text(orchestrationService.isRunFinished ? "Create another plan" : "Start another plan")
                            .font(AppFont.body(weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(Color.white)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                }

                Spacer(minLength: 24)
            }
            .padding(.vertical, 8)
        }
    }

    private func startNewPlan() {
        orchestrationService.reset()
        plan = .defaultTemplate
        startError = nil
        isStarting = false
        isCancelling = false
    }

    @ViewBuilder
    private func stepProgressRow(index: Int, step: OrchestrationStep) -> some View {
        let state = orchestrationService.stepStates[index] ?? .pending

        HStack(alignment: .top, spacing: 12) {
            // State indicator
            stepStateIcon(state)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("Step \(index + 1)")
                        .font(AppFont.subheadline(weight: .semibold))
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text(step.role.isEmpty ? step.agentId : step.role)
                        .font(AppFont.subheadline())
                        .foregroundStyle(.secondary)
                }

                Text(agentModelLabel(agentId: step.agentId, model: step.model))
                    .font(AppFont.caption())
                    .foregroundStyle(.tertiary)

                if case .completed(_, let summary) = state, !summary.isEmpty {
                    Text(summary)
                        .font(AppFont.footnote())
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                }

                if case .failed(let err) = state {
                    Text(err)
                        .font(AppFont.footnote())
                        .foregroundStyle(.red)
                        .padding(.top, 2)
                }
            }

            Spacer(minLength: 0)

            Text(state.displayLabel)
                .font(AppFont.caption(weight: .medium))
                .foregroundStyle(stepStateForeground(state))
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private func stepStateIcon(_ state: OrchestrationStepState) -> some View {
        switch state {
        case .pending:
            Image(systemName: "circle")
                .foregroundStyle(.tertiary)
        case .running:
            ProgressView()
                .controlSize(.small)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
        }
    }

    private func stepStateForeground(_ state: OrchestrationStepState) -> Color {
        switch state {
        case .pending: return .secondary
        case .running: return .accentColor
        case .completed: return .green
        case .failed: return .red
        }
    }

    private func agentModelLabel(agentId: String, model: String) -> String {
        let agentName = agentId == "claude-code" ? "Claude" : "Codex"
        return "\(agentName) · \(model)"
    }

    // MARK: - Cancel button

    private var cancelButton: some View {
        Button {
            sendCancelNotification()
        } label: {
            if isCancelling {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text("Cancel run")
                    .foregroundStyle(.red)
            }
        }
        .disabled(isCancelling)
    }

    private func sendCancelNotification() {
        guard let runId = orchestrationService.activeRunId else { return }
        isCancelling = true
        Task { @MainActor in
            defer { isCancelling = false }
            try? await codex.sendNotification(
                method: "orchestration/cancel",
                params: .object(["orchestrationId": .string(runId)])
            )
        }
    }
}
