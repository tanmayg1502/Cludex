// FILE: SidebarBottomActionBar.swift
// Purpose: Bottom-anchored sidebar bar. Hosts the Terminal pill on the leading
//          edge (same visual capsule used by the composer branch / runtime
//          pills via `ComposerPillLabel`) and the primary Chat FAB on the
//          trailing edge. iOS 26 routes through the shared adaptive glass API;
//          iOS 18 keeps the accent pill fallback.
// Layer: View Component
// Exports: SidebarBottomActionBar
// Depends on: SwiftUI, ComposerPillLabel, RemodexIcon, AppFont,
//             AdaptiveGlassModifier

import SwiftUI

struct SidebarBottomActionBar: View {
    let isChatEnabled: Bool
    let isCreatingThread: Bool
    let onTapChat: () -> Void
    let onTapTerminal: () -> Void

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                iOS26LiquidGlassLayout
            } else {
                iOS18FallbackLayout
            }
        }
        .padding(.horizontal, 16)
        // safeAreaBar(edge:.bottom) on iOS 26 already adds the system safe-area
        // inset, so we only need a tiny visual gap above/below the controls.
        .padding(.top, 6)
        .padding(.bottom, 4)
    }

    // MARK: - Terminal pill (shared visual with composer secondary bar)

    // Reuses ComposerPillLabel so the Terminal entry point reads exactly like
    // the runtime ("Local") and git branch ("main") pills under the chat
    // input — same capsule, padding, mono subheadline font and glass surface.
    private var terminalPill: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTapTerminal()
        } label: {
            ComposerPillLabel(
                title: "Terminal",
                iconSystemName: "terminal.fill",
                titleFont: AppFont.mono(.subheadline),
                titleWeight: .medium,
                showsTrailingChevron: false
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Terminal")
    }

    // MARK: - iOS 26 (Liquid Glass)

    private var iOS26LiquidGlassLayout: some View {
        // Groups the Terminal pill and Chat FAB in the same native Liquid
        // Glass sampling region when the runtime and user preference allow it.
        AdaptiveGlassContainer(spacing: 10) {
            HStack(spacing: 10) {
                terminalPill
                Spacer(minLength: 0)
                chatGlassFAB
            }
        }
    }

    private var chatGlassFAB: some View {
        // No explicit .frame on the label: prominent glass button styling +
        // `.controlSize(.large)` produce the canonical iOS 26 FAB size with
        // the right glass padding around the glyph.
        Button {
            HapticFeedback.shared.triggerImpactFeedback()
            onTapChat()
        } label: {
            if isCreatingThread {
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
            } else {
                RemodexIcon.image(systemName: "square.and.pencil", size: 22, weight: .semibold)
            }
        }
        .adaptiveGlassButtonStyle(.prominent)
        .controlSize(.large)
        .tint(.accentColor)
        .disabled(!isChatEnabled || isCreatingThread)
        .accessibilityLabel("New chat")
    }

    // MARK: - iOS 18 fallback (no Liquid Glass)

    private var iOS18FallbackLayout: some View {
        HStack(spacing: 10) {
            terminalPill
            Spacer(minLength: 0)
            iOS18ChatPill
        }
    }

    private var iOS18ChatPill: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback()
            onTapChat()
        } label: {
            HStack(spacing: 8) {
                if isCreatingThread {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    RemodexIcon.image(systemName: "square.and.pencil", size: 18, weight: .semibold)
                }

                Text("Chat")
                    .font(AppFont.subheadline(weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(
                Capsule()
                    .fill(isChatEnabled ? Color.accentColor : Color.accentColor.opacity(0.4))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!isChatEnabled || isCreatingThread)
        .accessibilityLabel("New chat")
    }
}

#if DEBUG
#Preview {
    SidebarBottomActionBar(
        isChatEnabled: true,
        isCreatingThread: false,
        onTapChat: {},
        onTapTerminal: {}
    )
}
#endif
