// FILE: SidebarHeaderView.swift
// Purpose: Top sidebar row with logo/title, detached utility shortcut (settings),
//          overflow creation menu, and the hamburger close affordance. All
//          icon buttons route through `SidebarToolbarIconButton` so they
//          share one visual treatment.
// Layer: View Component
// Exports: SidebarHeaderView, SidebarOverflowMenuActions
// Depends on: SwiftUI, SidebarToolbarIconButton, RemodexIcon, AdaptiveGlassModifier

import SwiftUI

struct SidebarOverflowMenuActions {
    var isEnabled: Bool
    var pendingAction: SidebarTopAction?
    var onNewChat: () -> Void
    var onQuickChat: () -> Void
    var onNewProject: () -> Void
    var onOpenTerminal: () -> Void
    var onOpenSettings: () -> Void
}

struct SidebarHeaderView: View {
    var showsCloseButton: Bool = true
    var onClose: () -> Void
    var overflowActions: SidebarOverflowMenuActions

    var body: some View {
        AdaptiveGlassContainer(spacing: 10) {
            HStack(spacing: 10) {
                appLogo
                Text("Remodex")
                    .font(AppFont.system(size: 28, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)

                Spacer(minLength: 0)

                SidebarToolbarIconButton(
                    icon: .systemImage("gearshape.fill"),
                    accessibilityLabel: "Settings",
                    action: overflowActions.onOpenSettings
                )

                overflowMenuButton

                if showsCloseButton {
                    hamburgerButton
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private var appLogo: some View {
        Image("AppLogo")
            .resizable()
            .scaledToFit()
            .frame(width: 26, height: 26)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // Close affordance kept inside the sidebar so both drawer and full-width
    // presentations share the same dismissal target.
    private var hamburgerButton: some View {
        SidebarToolbarIconButton(
            icon: .custom { TwoLineHamburgerIcon() },
            accessibilityLabel: "Close menu",
            action: onClose
        )
    }

    private var overflowMenuButton: some View {
        Menu {
            Section {
                Button {
                    overflowActions.onNewChat()
                } label: {
                    overflowMenuLabel("New Chat", systemName: "square.and.pencil")
                }

                Button {
                    overflowActions.onQuickChat()
                } label: {
                    overflowMenuLabel("Quick Chat", systemName: "message")
                }

                Button {
                    overflowActions.onNewProject()
                } label: {
                    overflowMenuLabel("New Project", systemName: "folder.badge.plus")
                }
            }
        } label: {
            // Reuses the same toolbar button shell so the ellipsis trigger
            // matches the surrounding settings + hamburger glyphs exactly.
            SidebarToolbarIconButton(
                icon: .systemImage("ellipsis"),
                accessibilityLabel: "More actions",
                action: {}
            )
            .allowsHitTesting(false)
        }
        .disabled(!overflowActions.isEnabled)
        .opacity(overflowActions.isEnabled ? 1 : 0.4)
        .accessibilityLabel("More actions")
    }

    // UIKit-backed Menu rows cannot host arbitrary SwiftUI icon views reliably;
    // pass the mapped asset name directly so custom central-* icons render.
    @ViewBuilder
    private func overflowMenuLabel(_ title: String, systemName: String) -> some View {
        if let assetName = RemodexIcon.assetName(for: systemName) {
            Label(title, image: assetName)
        } else {
            Label(title, systemImage: systemName)
        }
    }
}

#if DEBUG
#Preview {
    SidebarHeaderView(
        onClose: {},
        overflowActions: SidebarOverflowMenuActions(
            isEnabled: true,
            pendingAction: nil,
            onNewChat: {},
            onQuickChat: {},
            onNewProject: {},
            onOpenTerminal: {},
            onOpenSettings: {}
        )
    )
}
#endif
