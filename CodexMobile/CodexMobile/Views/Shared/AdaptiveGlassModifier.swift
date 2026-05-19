// FILE: AdaptiveGlassModifier.swift
// Purpose: Centralizes Liquid Glass availability, user preference, and fallback styling.
// Layer: View Modifier / Shared UI
// Exports: GlassPreference, AdaptiveGlassStyle, AdaptiveGlassContainer, adaptive glass view helpers
// Depends on: SwiftUI

import SwiftUI

// MARK: - Preference

enum GlassPreference {
    static let storageKey = "codex.useLiquidGlass"

    static var isSupported: Bool {
        if #available(iOS 26, *) { return true }
        return false
    }
}

// MARK: - Glass configuration

enum AdaptiveGlassStyle {
    case automatic
    case regular
}

enum AdaptiveGlassButtonProminence {
    case regular
    case prominent
}

// MARK: - Glass effect modifier

private struct AdaptiveGlassModifier<S: Shape>: ViewModifier {
    @AppStorage(GlassPreference.storageKey) private var glassEnabled = true
    let style: AdaptiveGlassStyle
    let isInteractive: Bool
    let tint: Color?
    let fallbackMaterial: Material
    let shape: S

    func body(content: Content) -> some View {
        if #available(iOS 26, *), glassEnabled {
            switch style {
            case .automatic:
                content.glassEffect(in: shape)
            case .regular:
                content.glassEffect(resolvedGlass, in: shape)
            }
        } else {
            content.background(fallbackMaterial, in: shape)
        }
    }

    @available(iOS 26, *)
    private var resolvedGlass: Glass {
        var glass = Glass.regular
        if let tint {
            glass = glass.tint(tint)
        }
        if isInteractive {
            glass = glass.interactive()
        }
        return glass
    }
}

// MARK: - Glass container

struct AdaptiveGlassContainer<Content: View>: View {
    @AppStorage(GlassPreference.storageKey) private var glassEnabled = true
    let spacing: CGFloat
    private let content: () -> Content

    init(spacing: CGFloat, @ViewBuilder content: @escaping () -> Content) {
        self.spacing = spacing
        self.content = content
    }

    var body: some View {
        if #available(iOS 26, *), glassEnabled {
            GlassEffectContainer(spacing: spacing) {
                content()
            }
        } else {
            content()
        }
    }
}

// MARK: - Glass button style

private struct AdaptiveGlassButtonStyleModifier: ViewModifier {
    @AppStorage(GlassPreference.storageKey) private var glassEnabled = true
    let prominence: AdaptiveGlassButtonProminence

    func body(content: Content) -> some View {
        if #available(iOS 26, *), glassEnabled {
            switch prominence {
            case .regular:
                content.buttonStyle(.glass)
            case .prominent:
                content.buttonStyle(.glassProminent)
            }
        } else {
            switch prominence {
            case .regular:
                content.buttonStyle(.borderless)
            case .prominent:
                content.buttonStyle(.borderedProminent)
            }
        }
    }
}

// MARK: - Navigation bar modifier

private struct AdaptiveNavigationBarModifier: ViewModifier {
    @AppStorage(GlassPreference.storageKey) private var glassEnabled = true

    func body(content: Content) -> some View {
        if #available(iOS 26, *), glassEnabled {
            content
        } else {
            content
        }
    }
}

// MARK: - Toolbar item fallback (glass OFF or iOS < 26)

private struct AdaptiveToolbarItemModifier<S: Shape>: ViewModifier {
    @AppStorage(GlassPreference.storageKey) private var glassEnabled = true
    let shape: S

    func body(content: Content) -> some View {
        if #available(iOS 26, *), glassEnabled {
            content.glassEffect(.regular.interactive(), in: shape)
        } else {
            content.background(.thinMaterial, in: shape)
        }
    }
}

// MARK: - View extensions

extension View {
    func adaptiveGlass(_ style: AdaptiveGlassStyle, in shape: some Shape) -> some View {
        adaptiveGlass(style, isInteractive: false, tint: nil, fallbackMaterial: .thinMaterial, in: shape)
    }

    func adaptiveGlass(
        _ style: AdaptiveGlassStyle,
        isInteractive: Bool,
        tint: Color? = nil,
        fallbackMaterial: Material = .thinMaterial,
        in shape: some Shape
    ) -> some View {
        modifier(AdaptiveGlassModifier(
            style: style,
            isInteractive: isInteractive,
            tint: tint,
            fallbackMaterial: fallbackMaterial,
            shape: shape
        ))
    }

    func adaptiveGlass(in shape: some Shape) -> some View {
        adaptiveGlass(.automatic, isInteractive: false, tint: nil, fallbackMaterial: .thinMaterial, in: shape)
    }

    func adaptiveGlassButtonStyle(_ prominence: AdaptiveGlassButtonProminence = .regular) -> some View {
        modifier(AdaptiveGlassButtonStyleModifier(prominence: prominence))
    }

    func adaptiveNavigationBar() -> some View {
        modifier(AdaptiveNavigationBarModifier())
    }

    func adaptiveToolbarItem(in shape: some Shape) -> some View {
        modifier(AdaptiveToolbarItemModifier(shape: shape))
    }
}
