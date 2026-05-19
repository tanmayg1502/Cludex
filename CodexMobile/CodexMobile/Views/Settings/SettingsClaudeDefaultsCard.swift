// FILE: SettingsClaudeDefaultsCard.swift
// Purpose: Settings card for Claude default model, permission mode, and approval timeout.
// Layer: Settings UI component
// Exports: SettingsClaudeDefaultsCard
// Depends on: SwiftUI, AppFont, CodexService

import SwiftUI

struct SettingsClaudeDefaultsCard: View {
    @Environment(CodexService.self) private var codex

    @AppStorage("claude.defaultModel")         private var defaultModel = "claude-sonnet-4-6"
    @AppStorage("claude.permissionMode")       private var permissionMode = "acceptEdits"
    @AppStorage("claude.permissionTimeoutSecs") private var permissionTimeoutSecs = 30

    private let timeoutOptions: [(label: String, value: Int)] = [
        ("10 seconds", 10),
        ("30 seconds (default)", 30),
        ("60 seconds", 60),
        ("2 minutes", 120),
    ]

    var body: some View {
        SettingsCard(title: "Claude") {
            Picker("Model", selection: $defaultModel) {
                ForEach(claudeModels, id: \.id) { model in
                    Text(model.displayName).tag(model.model)
                }
                if claudeModels.isEmpty {
                    Text("Claude Sonnet (default)").tag("claude-sonnet-4-6")
                }
            }
            .pickerStyle(.menu)
            .tint(.primary)

            Picker("Permission mode", selection: $permissionMode) {
                Text("Accept edits (recommended)").tag("acceptEdits")
                Text("Bypass all permissions").tag("bypassPermissions")
            }
            .pickerStyle(.menu)
            .tint(.primary)

            Picker("Auto-deny after", selection: $permissionTimeoutSecs) {
                ForEach(timeoutOptions, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .pickerStyle(.menu)
            .tint(.primary)
        }
    }

    private var claudeModels: [CodexModelOption] {
        codex.availableModels.filter { $0.model.hasPrefix("claude-") }
    }
}
