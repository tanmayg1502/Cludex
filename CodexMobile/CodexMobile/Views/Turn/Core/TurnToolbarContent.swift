// FILE: TurnToolbarContent.swift
// Purpose: Encapsulates the TurnView navigation toolbar and thread-path sheet.
// Layer: View Component
// Exports: TurnToolbarContent, TurnThreadNavigationContext

import SwiftUI
import UIKit

struct TurnThreadNavigationContext {
    let folderName: String
    let subtitle: String
    let fullPath: String
}

private enum TurnThreadAgentOption: String, CaseIterable, Identifiable {
    case codex = "codex"
    case claude = "claude-code"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .codex:
            return "Codex"
        case .claude:
            return "Claude"
        }
    }

    var systemName: String {
        switch self {
        case .codex:
            return "sparkles"
        case .claude:
            return "terminal"
        }
    }

    static func resolved(from agentId: String?) -> TurnThreadAgentOption {
        switch agentId?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case TurnThreadAgentOption.claude.rawValue:
            return .claude
        default:
            return .codex
        }
    }
}

struct TurnToolbarContent: ToolbarContent {
    let displayTitle: String
    let navigationContext: TurnThreadNavigationContext?
    let showsThreadActions: Bool
    let isHandingOffToMac: Bool
    let isStartingNewChat: Bool
    let canHandOffToWorktree: Bool
    let worktreeHandoffTitle: String
    let isCreatingGitWorktree: Bool
    let repoDiffTotals: GitDiffTotals?
    let isLoadingRepoDiff: Bool
    let showsGitActions: Bool
    let isGitActionEnabled: Bool
    let disabledGitActions: Set<TurnGitActionKind>
    let isRunningGitAction: Bool
    let gitActionLoadingTitle: String?
    let showsDiscardRuntimeChangesAndSync: Bool
    let gitSyncState: String?
    var onTapMacHandoff: (() -> Void)?
    var onTapWorktreeHandoff: (() -> Void)?
    var onTapNewChat: (() -> Void)?
    var onTapTerminal: (() -> Void)?
    var onTapRepoDiff: (() -> Void)?
    let onGitAction: (TurnGitActionKind) -> Void

    @Binding var isShowingPathSheet: Bool

    var body: some ToolbarContent {
        let hasTrailingCluster = showsGitActions
        let isThreadActionLoading = isHandingOffToMac || isStartingNewChat
        let canTapMacHandoff = onTapMacHandoff != nil && !isThreadActionLoading
        let canTapWorktreeHandoff = onTapWorktreeHandoff != nil
            && canHandOffToWorktree
            && !isCreatingGitWorktree
            && !isThreadActionLoading
        let canTapNewChat = onTapNewChat != nil && !isThreadActionLoading
        let canTapTerminal = onTapTerminal != nil

        ToolbarItem(placement: .principal) {
            VStack(alignment: .leading, spacing: 1) {
                Text(displayTitle)
                    .font(AppFont.subheadline(weight: .medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let context = navigationContext {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        isShowingPathSheet = true
                    } label: {
                        Text(context.subtitle)
                            .font(AppFont.caption(weight: .regular))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        if showsThreadActions {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // Keeps all "branch from here" actions together behind the compact toolbar affordance.
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onTapMacHandoff?()
                    } label: {
                        HStack(spacing: 10) {
                            ResizableThreadActionSymbol(systemName: "arrow.left.arrow.right", pointSize: 13)
                            Text("Continue on Desktop App")
                        }
                    }
                    .disabled(!canTapMacHandoff)

                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onTapWorktreeHandoff?()
                    } label: {
                        CodexWorktreeMenuLabelRow(
                            title: isCreatingGitWorktree ? "Preparing worktree..." : worktreeHandoffTitle,
                            pointSize: 12,
                            weight: .regular
                        )
                    }
                    .disabled(!canTapWorktreeHandoff)

                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onTapNewChat?()
                    } label: {
                        HStack(spacing: 10) {
                            ResizableThreadActionSymbol(systemName: "plus.app", pointSize: 13)
                            Text("New chat")
                        }
                    }
                    .disabled(!canTapNewChat)

                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        onTapTerminal?()
                    } label: {
                        HStack(spacing: 10) {
                            ResizableThreadActionSymbol(systemName: "terminal", pointSize: 13)
                            Text("Open Terminal Here")
                        }
                    }
                    .disabled(!canTapTerminal)
                } label: {
                    TurnMacHandoffToolbarLabel(isLoading: isThreadActionLoading)
                }
                .accessibilityLabel("Thread actions")
            }
        }

        if showsThreadActions, hasTrailingCluster {
            if #available(iOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
        }

        if showsGitActions {
            ToolbarItem(placement: .topBarTrailing) {
                TurnGitActionsToolbarButton(
                    isEnabled: isGitActionEnabled,
                    disabledActions: disabledGitActions,
                    isRunningAction: isRunningGitAction,
                    loadingTitle: gitActionLoadingTitle,
                    showsDiscardRuntimeChangesAndSync: showsDiscardRuntimeChangesAndSync,
                    gitSyncState: gitSyncState,
                    repoDiffTotals: repoDiffTotals,
                    isLoadingRepoDiff: isLoadingRepoDiff,
                    onTapRepoDiff: onTapRepoDiff,
                    onSelect: onGitAction
                )
            }
        }
    }
}

private struct TurnMacHandoffToolbarLabel: View {
    let isLoading: Bool

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 24, height: 24)
            } else {
                ResizableThreadActionSymbol(systemName: "arrow.trianglehead.branch", pointSize: 14)
                    .foregroundStyle(.primary)
                    .frame(width: 24, height: 24)
            }
        }
        .contentShape(Circle())
        .adaptiveToolbarItem(in: Circle())
    }
}

private struct ResizableThreadActionSymbol: View {
    let systemName: String
    let pointSize: CGFloat
    var weight: UIImage.SymbolWeight = .semibold

    var body: some View {
        Image(uiImage: resizedSymbol(named: systemName, pointSize: pointSize, weight: weight))
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: pointSize, height: pointSize)
    }

    private func resizedSymbol(named name: String, pointSize: CGFloat, weight: UIImage.SymbolWeight) -> UIImage {
        let config = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
        guard let symbol = RemodexIcon.uiImage(systemName: name, withConfiguration: config)?
            .withRenderingMode(.alwaysTemplate) else {
            return UIImage()
        }

        let canvasSide = max(symbol.size.width, symbol.size.height)
        let canvasSize = CGSize(width: canvasSide, height: canvasSide)
        let renderer = UIGraphicsImageRenderer(size: canvasSize)
        let scale = min(canvasSize.width / symbol.size.width, canvasSize.height / symbol.size.height)
        let scaledSize = CGSize(width: symbol.size.width * scale, height: symbol.size.height * scale)
        let origin = CGPoint(
            x: (canvasSize.width - scaledSize.width) / 2,
            y: (canvasSize.height - scaledSize.height) / 2
        )

        return renderer.image { _ in
            symbol.draw(in: CGRect(origin: origin, size: scaledSize))
        }
        .withRenderingMode(.alwaysTemplate)
    }
}

struct TurnThreadPathSheet: View {
    let context: TurnThreadNavigationContext
    let threadTitle: String
    let currentAgentId: String?
    let isAgentControlEnabled: Bool
    var onRenameThread: ((String) -> Void)? = nil
    var onUpdateThreadAgent: ((String) async throws -> Void)? = nil

    @State private var renamePrompt = ThreadRenamePromptState()
    @State private var didCopyPath = false
    @State private var selectedAgent = TurnThreadAgentOption.codex
    @State private var isUpdatingAgent = false
    @State private var agentUpdateErrorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if onRenameThread != nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Thread")
                                .font(AppFont.caption(weight: .semibold))
                                .foregroundStyle(.secondary)

                            HStack(alignment: .center, spacing: 12) {
                                Text(threadTitle)
                                    .font(AppFont.body(weight: .medium))
                                    .foregroundStyle(.primary)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                Button {
                                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                                    renamePrompt.present(currentTitle: threadTitle)
                                } label: {
                                    RemodexIcon.image(systemName: "pencil")
                                        .font(AppFont.system(size: 14, weight: .semibold))
                                        .frame(width: 32, height: 32)
                                        .contentShape(Circle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Rename conversation")
                            }
                        }
                    }

                    if onUpdateThreadAgent != nil {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .center, spacing: 8) {
                                Text("Agent")
                                    .font(AppFont.caption(weight: .semibold))
                                    .foregroundStyle(.secondary)

                                if isUpdatingAgent {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                            }

                            Picker("Agent", selection: agentSelectionBinding) {
                                ForEach(TurnThreadAgentOption.allCases) { option in
                                    RemodexIcon.label(option.title, systemName: option.systemName)
                                        .tag(option)
                                }
                            }
                            .pickerStyle(.segmented)
                            .disabled(!isAgentControlEnabled || isUpdatingAgent)

                            if let agentUpdateErrorMessage {
                                Text(agentUpdateErrorMessage)
                                    .font(AppFont.caption())
                                    .foregroundStyle(.red)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Text("Path")
                                .font(AppFont.caption(weight: .semibold))
                                .foregroundStyle(.secondary)

                            Button {
                                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                                copyPathToPasteboard()
                            } label: {
                                Group {
                                    if didCopyPath {
                                        RemodexIcon.image(systemName: "checkmark")
                                            .font(AppFont.system(size: 12, weight: .semibold))
                                    } else {
                                        Image("copy")
                                            .renderingMode(.template)
                                            .resizable()
                                            .scaledToFit()
                                            .scaleEffect(x: -1, y: 1)
                                    }
                                }
                                .frame(width: 16, height: 16)
                                .foregroundStyle(.secondary)
                                .frame(width: 32, height: 32)
                                .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(didCopyPath ? "Path copied" : "Copy path")
                        }

                        Text(context.fullPath)
                            .font(AppFont.mono(.callout))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
            }
            .navigationTitle(context.folderName)
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
        }
        .presentationDetents([.fraction(0.45), .medium])
        .onAppear {
            selectedAgent = TurnThreadAgentOption.resolved(from: currentAgentId)
        }
        .onChange(of: currentAgentId) { _, newValue in
            guard !isUpdatingAgent else { return }
            selectedAgent = TurnThreadAgentOption.resolved(from: newValue)
        }
        .threadRenamePrompt(state: $renamePrompt) { newTitle in
            onRenameThread?(newTitle)
        }
    }

    private var agentSelectionBinding: Binding<TurnThreadAgentOption> {
        Binding(
            get: { selectedAgent },
            set: { newSelection in
                guard newSelection != selectedAgent else { return }
                let previousSelection = selectedAgent
                selectedAgent = newSelection
                agentUpdateErrorMessage = nil
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                updateAgent(to: newSelection, revertingTo: previousSelection)
            }
        )
    }

    private func updateAgent(to selection: TurnThreadAgentOption, revertingTo previousSelection: TurnThreadAgentOption) {
        guard let onUpdateThreadAgent else { return }

        isUpdatingAgent = true
        Task { @MainActor in
            do {
                try await onUpdateThreadAgent(selection.rawValue)
            } catch {
                selectedAgent = previousSelection
                agentUpdateErrorMessage = error.localizedDescription.isEmpty
                    ? "Could not update the thread agent."
                    : error.localizedDescription
            }

            isUpdatingAgent = false
        }
    }

    // Copies the full local project path while keeping the sheet visible.
    private func copyPathToPasteboard() {
        UIPasteboard.general.string = context.fullPath
        withAnimation(.easeInOut(duration: 0.15)) {
            didCopyPath = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            withAnimation(.easeInOut(duration: 0.15)) {
                didCopyPath = false
            }
        }
    }
}
