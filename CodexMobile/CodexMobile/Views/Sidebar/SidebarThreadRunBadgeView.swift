// FILE: SidebarThreadRunBadgeView.swift
// Purpose: Renders the compact run-state indicator dot for sidebar conversation rows.
// Layer: View Component
// Exports: SidebarThreadRunBadgeView
// Depends on: SwiftUI, CodexThreadRunBadgeState

import SwiftUI

struct SidebarThreadRunBadgeView: View {
    let state: CodexThreadRunBadgeState

    var body: some View {
        switch state {
        case .multiAgentProgress(let completed, let total):
            multiAgentProgressBadge(completed: completed, total: total)
        default:
            stateDot
        }
    }

    private var stateDot: some View {
        Circle()
            .fill(state.dotColor)
            .frame(width: 10, height: 10)
            .overlay(
                Circle()
                    .stroke(Color(.systemBackground), lineWidth: 1)
            )
            .accessibilityHidden(true)
    }

    private func multiAgentProgressBadge(completed: Int, total: Int) -> some View {
        Text("\(completed)/\(total)")
            .font(AppFont.caption2())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Color(.secondarySystemFill), in: Capsule())
            .accessibilityLabel("\(completed) of \(total) steps complete")
    }
}

private extension CodexThreadRunBadgeState {
    var dotColor: Color {
        switch self {
        case .running:
            return .blue
        case .ready:
            return .green
        case .failed:
            return .red
        case .multiAgentProgress:
            return .blue
        }
    }
}
