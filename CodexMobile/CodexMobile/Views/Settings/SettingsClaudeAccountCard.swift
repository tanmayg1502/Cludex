// FILE: SettingsClaudeAccountCard.swift
// Purpose: Presents bridge-owned Claude authentication status and login action.
// Layer: Settings UI component
// Exports: SettingsClaudeAccountCard
// Depends on: SwiftUI, AppFont, CodexService

import SwiftUI

struct SettingsClaudeAccountCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    @State private var isSigningIn = false
    @State private var isRefreshing = false

    var body: some View {
        SettingsCard(title: "Claude account") {
            HStack(spacing: 10) {
                Text("Status")
                Spacer()
                SettingsStatusPill(label: statusLabel)
            }

            if let detailText = codex.claudeAccountSnapshot.detailText {
                HStack(spacing: 12) {
                    Text("Account")
                    Spacer()
                    Text(detailText)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            } else {
                Text(guidanceText)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if !codex.claudeAccountSnapshot.isAuthenticated {
                SettingsButton("Sign in to Claude", isLoading: isSigningIn) {
                    startClaudeSignIn()
                }
                .disabled(!codex.isConnected || isSigningIn || codex.claudeAccountSnapshot.loginInFlight)
            }

            SettingsButton("Refresh", isLoading: isRefreshing) {
                refreshClaudeStatus()
            }
            .disabled(!codex.isConnected || isRefreshing || isSigningIn)

            if let errorMessage = codex.claudeAccountErrorMessage,
               !errorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(errorMessage)
                    .font(AppFont.caption())
                    .foregroundStyle(.red)
            }
        }
        .task {
            await refreshClaudeStatusIfConnected()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                return
            }
            Task {
                await refreshClaudeStatusIfConnected()
            }
        }
    }

    private var statusLabel: String {
        if isSigningIn || codex.claudeAccountSnapshot.loginInFlight {
            return "Signing in"
        }
        return codex.claudeAccountSnapshot.isAuthenticated ? "Connected" : "Not connected"
    }

    private var guidanceText: String {
        guard codex.isConnected else {
            return "Connect to your computer bridge to read Claude status."
        }

        switch codex.claudeAccountSnapshot.status {
        case .authenticated:
            return "Claude is connected on your computer."
        case .loginPending:
            return "Finish Claude sign-in in the browser on your computer."
        case .unavailable:
            return "Claude status is unavailable from this computer bridge."
        case .unknown:
            return "Refresh to read Claude status from your computer."
        case .notLoggedIn:
            return "Sign in on your computer to use Claude chats."
        }
    }

    private func startClaudeSignIn() {
        guard !isSigningIn else {
            return
        }

        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        isSigningIn = true
        Task {
            do {
                _ = try await codex.startClaudeLogin()
            } catch {
                await MainActor.run {
                    codex.claudeAccountErrorMessage = error.localizedDescription
                }
            }

            await MainActor.run {
                isSigningIn = false
            }
        }
    }

    private func refreshClaudeStatus() {
        guard !isRefreshing else {
            return
        }

        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        isRefreshing = true
        Task {
            await codex.refreshClaudeAccountState()
            await MainActor.run {
                isRefreshing = false
            }
        }
    }

    private func refreshClaudeStatusIfConnected() async {
        guard codex.isConnected, !isRefreshing, !isSigningIn else {
            return
        }

        await MainActor.run {
            isRefreshing = true
        }
        await codex.refreshClaudeAccountState()
        await MainActor.run {
            isRefreshing = false
        }
    }
}
