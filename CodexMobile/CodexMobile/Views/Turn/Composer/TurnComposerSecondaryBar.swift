// FILE: TurnComposerSecondaryBar.swift
// Purpose: Owns the secondary composer controls shown below the main input card.
// Layer: View Component
// Exports: TurnComposerSecondaryBar
// Depends on: SwiftUI, UIKit, TurnGitBranchSelector, ContextWindowProgressRing,
//             CodexWorktreeMenuLabelRow, ComposerPillLabel

import SwiftUI
import UIKit

struct TurnComposerSecondaryBar: View {
    let isInputFocused: Bool
    let isEmptyThread: Bool
    let hasWorkingDirectory: Bool
    let isWorktreeProject: Bool

    let selectedAccessMode: CodexAccessMode
    let contextWindowUsage: ContextWindowUsage?
    let rateLimitBuckets: [CodexRateLimitBucket]
    let isLoadingRateLimits: Bool
    let rateLimitsErrorMessage: String?
    let shouldAutoRefreshUsageStatus: Bool

    let showsGitBranchSelector: Bool
    let isGitBranchSelectorEnabled: Bool
    let availableGitBranchTargets: [String]
    let gitBranchesCheckedOutElsewhere: Set<String>
    let gitWorktreePathsByBranch: [String: String]
    let selectedGitBaseBranch: String
    let currentGitBranch: String
    let gitDefaultBranch: String
    let isLoadingGitBranchTargets: Bool
    let isSwitchingGitBranch: Bool
    let isCreatingGitWorktree: Bool

    let onSelectGitBranch: (String) -> Void
    let onCreateGitBranch: (String) -> Void
    let onSelectGitBaseBranch: (String) -> Void
    let onRefreshGitBranches: () -> Void
    let onRefreshUsageStatus: () async -> Void
    let onSelectAccessMode: (CodexAccessMode) -> Void
    let canHandOffToWorktree: Bool
    let onTapCreateWorktree: () -> Void

    private let branchLabelColor = Color(.secondaryLabel)
    private let accessControlSize: CGFloat = 36
    // Icona dentro il cerchio access-mode: dimensionata per matchare il rapporto
    // icon/container dei ComposerPillLabel (~0.55) invece di scalare col font ambient,
    // altrimenti l'asset central-shield-* (viewBox 24 con padding interno) risulta
    // visibilmente più piccolo delle icone "Local"/"main".
    private let accessControlIconSize: CGFloat = 20
    private var branchTextFont: Font { AppFont.subheadline() }
    private var runtimeLabelTitle: String {
        if !hasWorkingDirectory {
            return "Quick Chat"
        }
        return isWorktreeProject ? "Worktree" : "Local"
    }
    private var runtimeIconSystemName: String {
        if !hasWorkingDirectory {
            return "bubble.left.and.bubble.right"
        }
        return isWorktreeProject ? "arrow.triangle.branch" : "laptopcomputer"
    }

    // ─── ENTRY POINT ─────────────────────────────────────────────
    var body: some View {
        Group {
            if !isInputFocused {
                HStack(spacing: 8) {
                    runtimePicker

                    if showsGitBranchSelector {
                        TurnGitBranchSelector(
                            isEnabled: isGitBranchSelectorEnabled,
                            availableGitBranchTargets: availableGitBranchTargets,
                            gitBranchesCheckedOutElsewhere: gitBranchesCheckedOutElsewhere,
                            gitWorktreePathsByBranch: gitWorktreePathsByBranch,
                            selectedGitBaseBranch: selectedGitBaseBranch,
                            currentGitBranch: currentGitBranch,
                            defaultBranch: gitDefaultBranch,
                            isLoadingGitBranchTargets: isLoadingGitBranchTargets,
                            isSwitchingGitBranch: isSwitchingGitBranch,
                            onSelectGitBranch: onSelectGitBranch,
                            onCreateGitBranch: onCreateGitBranch,
                            onSelectGitBaseBranch: onSelectGitBaseBranch,
                            onRefreshGitBranches: onRefreshGitBranches
                        )
                        .equatable()
                    }

                    Spacer()

                    accessMenuLabel
                    statusControlCircle
                }

                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }

    // ─── Menus ───────────────────────────────────────────────────

    private var accessMenuLabel: some View {
        Menu {
            ForEach(CodexAccessMode.allCases, id: \.rawValue) { mode in
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onSelectAccessMode(mode)
                } label: {
                    if selectedAccessMode == mode {
                        Label(mode.menuTitle, systemImage: "checkmark")
                    } else {
                        Text(mode.menuTitle)
                    }
                }
            }
        } label: {
            RemodexIcon.image(
                systemName: selectedAccessMode == .fullAccess ? "hand.thumbsup" : "hand.raised",
                size: accessControlIconSize
            )
            .frame(width: accessControlSize, height: accessControlSize)
            .adaptiveGlass(.regular, in: Circle())
            .foregroundStyle(selectedAccessMode == .fullAccess ? .orange : branchLabelColor)
            .contentShape(Circle())
        }
        .menuIndicator(.hidden)
        .tint(branchLabelColor)
    }

    private var runtimePicker: some View {
        Menu {
            Section("Continue in") {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    if let url = URL(string: "https://chatgpt.com/codex") {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    RemodexIcon.label("Cloud", systemName: "cloud")
                }

                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTapCreateWorktree()
                } label: {
                    CodexWorktreeMenuLabelRow(
                        title: isCreatingGitWorktree
                            ? "Preparing worktree..."
                            : isWorktreeProject ? "Hand off to Local" : isEmptyThread ? "New worktree" : "Hand off to Worktree",
                        pointSize: 12,
                        weight: .regular
                    )
                }
                .disabled(!canHandOffToWorktree || isCreatingGitWorktree || isSwitchingGitBranch)

                Button {
                    // Returning to Local is intentionally disabled until it can move code + branch safely.
                } label: {
                    TurnComposerRuntimeMenuRow(title: "Local") {
                        RemodexIcon.image(systemName: "laptopcomputer")
                    }
                }
                .disabled(true)
            }
        } label: {
            ComposerPillLabel(
                title: runtimeLabelTitle,
                iconSystemName: runtimeIconSystemName,
                foregroundColor: branchLabelColor,
                titleFont: branchTextFont
            )
        }
        .tint(branchLabelColor)
    }

    private var statusControlCircle: some View {
        ContextWindowProgressRing(
            usage: contextWindowUsage,
            rateLimitBuckets: rateLimitBuckets,
            isLoadingRateLimits: isLoadingRateLimits,
            rateLimitsErrorMessage: rateLimitsErrorMessage,
            shouldAutoRefreshStatus: shouldAutoRefreshUsageStatus,
            onRefreshStatus: onRefreshUsageStatus
        )
    }
}

private struct TurnComposerRuntimeMenuRow<Icon: View>: View {
    let title: String
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        HStack(spacing: 10) {
            icon()
                .frame(width: 16, height: 16)

            Text(title)
        }
    }
}
