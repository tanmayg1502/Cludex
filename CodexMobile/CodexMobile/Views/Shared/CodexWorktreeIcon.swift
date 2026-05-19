// FILE: CodexWorktreeIcon.swift
// Purpose: Shared fork + worktree icons so branching affordances stay visually aligned across the app.
// Layer: View Component
// Exports: CodexForkIcon, CodexWorktreeIcon, CodexWorktreeMenuLabelRow
// Depends on: SwiftUI, AppFont

import SwiftUI
import UIKit

struct CodexForkIcon: View {
    var pointSize: CGFloat = 13

    var body: some View {
        // `remodex.fork` is a virtual key in RemodexIcon mapped to
        // central-fork-code; routing through RemodexIcon keeps Dynamic Type
        // scaling and the square anchor logic in one place.
        RemodexIcon.image(systemName: "remodex.fork", size: pointSize)
    }
}

struct CodexWorktreeIcon: View {
    var pointSize: CGFloat = 13
    var weight: Font.Weight = .regular

    var body: some View {
        // Native SF Symbol: keeps the worktree icon aligned with the system
        // appearance the rest of the OS uses for branch/worktree affordances.
        RemodexIcon.image(
            systemName: "arrow.triangle.branch",
            size: pointSize,
            weight: weight
        )
    }

    static func menuImage(pointSize: CGFloat = 13, weight: UIImage.SymbolWeight = .regular) -> UIImage {
        let configuration = UIImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
        guard let symbol = UIImage(systemName: "arrow.triangle.branch", withConfiguration: configuration)?
            .withRenderingMode(.alwaysTemplate) else {
            return UIImage()
        }
        return symbol
    }
}

struct CodexWorktreeMenuLabelRow: View {
    let title: String
    var pointSize: CGFloat = 13
    var weight: UIImage.SymbolWeight = .regular

    var body: some View {
        HStack(spacing: 10) {
            Image(uiImage: CodexWorktreeIcon.menuImage(pointSize: pointSize, weight: weight))
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: pointSize, height: pointSize)
            Text(title)
        }
    }
}
