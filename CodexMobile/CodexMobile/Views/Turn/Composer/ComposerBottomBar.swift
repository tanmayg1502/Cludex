// FILE: ComposerBottomBar.swift
// Purpose: Bottom bar with attachment/runtime/access menus, queue controls, and send button.
// Layer: View Component
// Exports: ComposerBottomBar
// Depends on: SwiftUI, TurnComposerMetaMapper, UIKitMenuButton, TurnComposerRuntimeUIKitMenuBuilder

import SwiftUI

struct ComposerBottomBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(UserBubbleColor.storageKey) private var userBubbleColorRawValue = UserBubbleColor.defaultStoredRawValue
    @State private var showsAllModelsSheet = false

    // Data
    let orderedModelOptions: [CodexModelOption]
    let selectedModelID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool
    let isRuntimeSelectionLoading: Bool
    let runtimeState: TurnComposerRuntimeState
    let runtimeActions: TurnComposerRuntimeActions
    let remainingAttachmentSlots: Int
    let isComposerInteractionLocked: Bool
    let isSendDisabled: Bool
    let isSending: Bool
    let isPlanModeArmed: Bool
    let queuedCount: Int
    let isQueuePaused: Bool
    let activeTurnID: String?
    let isThreadRunning: Bool
    let voiceButtonPresentation: TurnComposerVoiceButtonPresentation
    let onTapAddImage: () -> Void
    let onTapTakePhoto: () -> Void
    let onTapVoice: () -> Void
    let onSetPlanModeArmed: (Bool) -> Void
    let onResumeQueue: () -> Void
    let onStopTurn: (String?) -> Void
    let onSend: () -> Void

    // MARK: - Constants

    private let metaLabelColor = Color(.secondaryLabel)
    private var metaTextFont: Font { AppFont.subheadline() }
    private var metaSymbolFont: Font { AppFont.system(size: 11, weight: .regular) }
    private let metaVerticalPadding: CGFloat = 6
    private let plusTapTargetSide: CGFloat = 22

    private var selectedUserBubbleColor: UserBubbleColor {
        UserBubbleColor(rawValue: userBubbleColorRawValue) ?? .default
    }

    // The send button is a CTA: treat the neutral "Default" palette the same
    // as the "Primary" (.black) palette so it stays a bold label-colored circle
    // regardless of which neutral the user picked.
    private var sendButtonPaletteColor: UserBubbleColor {
        selectedUserBubbleColor == .default ? .black : selectedUserBubbleColor
    }

    private var sendButtonIconColor: Color {
        if isSendDisabled { return Color(.systemGray2) }
        return sendButtonPaletteColor.bubbleForeground(for: colorScheme)
    }

    private var sendButtonBackgroundColor: Color {
        if isSendDisabled { return Color(.systemGray5) }
        return sendButtonPaletteColor.bubbleBackground(for: colorScheme)
    }

    // MARK: - Body

    var body: some View {
        HStack(spacing: 12) {
            attachmentMenu
                .padding(.leading, 8)
            ComposerRuntimeMenuControl(
                orderedModelOptions: orderedModelOptions,
                selectedModelID: selectedModelID,
                selectedModelTitle: selectedModelTitle,
                isLoadingModels: isLoadingModels,
                isRuntimeSelectionLoading: isRuntimeSelectionLoading,
                runtimeState: runtimeState,
                runtimeActions: runtimeActions,
                showsAllModelsSheet: $showsAllModelsSheet
            )
            .equatable()
            if isPlanModeArmed {
                Divider()
                    .frame(height: 16)
                planModeIndicator
            }
            Spacer(minLength: 0)

            if isQueuePaused && queuedCount > 0 {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onResumeQueue()
                } label: {
                    RemodexCircleBadge(
                        systemName: "arrow.clockwise",
                        foreground: Color(.systemBackground),
                        background: Color(.systemGray2),
                        diameter: 28
                    )
                }
                .accessibilityLabel("Resume queued messages")
            }

            // Voice -> Stop/loading -> Send. New sends can look running before the turn id is interruptible.
            Button {
                HapticFeedback.shared.triggerImpactFeedback()
                onTapVoice()
            } label: {
                voiceButtonLabel
            }
            .disabled(voiceButtonPresentation.isDisabled)
            .accessibilityLabel(voiceButtonPresentation.accessibilityLabel)

            if isThreadRunning && isSending && activeTurnID == nil {
                ProgressView()
                    .tint(Color(.label))
                    .frame(width: 32, height: 32)
                    .accessibilityLabel("Starting run")
            } else if isThreadRunning {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onStopTurn(activeTurnID)
                } label: {
                    RemodexCircleBadge(
                        systemName: "stop.fill",
                        foreground: sendButtonPaletteColor.bubbleForeground(for: colorScheme),
                        background: sendButtonPaletteColor.bubbleBackground(for: colorScheme)
                    )
                }
                .accessibilityLabel("Stop current run")
            }

            Button {
                HapticFeedback.shared.triggerImpactFeedback()
                onSend()
            } label: {
                RemodexCircleBadge(
                    systemName: "arrow.up",
                    foreground: sendButtonIconColor,
                    background: sendButtonBackgroundColor
                )
            }
            .overlay(alignment: .topTrailing) {
                if queuedCount > 0 {
                    queueBadge
                        .offset(x: 8, y: -8)
                }
            }
            .disabled(isSendDisabled)
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        .padding(.top, 2)
        .sheet(isPresented: $showsAllModelsSheet) {
            AllModelsSheet(
                models: orderedModelOptions,
                selectedModelID: selectedModelID,
                isLoadingModels: isLoadingModels,
                modelSupportsFastMode: modelSupportsFastMode,
                onSelect: { modelID in
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    runtimeActions.selectModel(modelID)
                    showsAllModelsSheet = false
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private var voiceButtonLabel: some View {
        Group {
            if voiceButtonPresentation.showsProgress {
                CircularIconBadge(
                    foreground: voiceButtonPresentation.foregroundColor,
                    background: voiceButtonPresentation.backgroundColor
                ) {
                    ProgressView()
                }
            } else if voiceButtonPresentation.hasCircleBackground {
                // Force the native SF Symbol via a raw `Image(systemName:)`
                // (bypassing `RemodexIcon`'s custom asset mapping) so the
                // mic/stop glyph inside the circle matches the surrounding
                // send/stop buttons rather than the stylised central-* asset.
                CircularIconBadge(
                    foreground: voiceButtonPresentation.foregroundColor,
                    background: voiceButtonPresentation.backgroundColor
                ) {
                    Image(systemName: voiceButtonPresentation.systemImageName)
                        .font(.system(size: 17, weight: .regular))
                }
            } else {
                // Outline mic accanto a plus/flash. L'asset central-microphone
                // ha un viewBox 24x24 con padding interno (glyph effettivo ~18pt),
                // quindi anchorlo al font ambient lo fa apparire piccolo.
                // Lo forziamo a riempire l'intero tap target così il glyph
                // visibile combacia con il + plus / flash.
                RemodexIcon.image(
                    systemName: voiceButtonPresentation.systemImageName,
                    size: plusTapTargetSide
                )
                .foregroundStyle(metaLabelColor)
                .frame(width: plusTapTargetSide, height: plusTapTargetSide)
                .contentShape(Rectangle())
            }
        }
    }

    // MARK: - Menus

    private var attachmentMenu: some View {
        Menu {
            Toggle(isOn: Binding(
                get: { isPlanModeArmed },
                set: { newValue in
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onSetPlanModeArmed(newValue)
                }
            )) {
                RemodexIcon.label("Plan mode", systemName: "checklist")
            }

            if runtimeState.supportsFastMode {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    toggleFastMode()
                } label: {
                    RemodexIcon.label("Fast Mode", systemName: fastModePlusMenuIconName)
                }
            }

            Section {
                Button("Photo library") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onTapAddImage()
                }
                .disabled(remainingAttachmentSlots == 0)

                Button("Take a photo") {
                    HapticFeedback.shared.triggerImpactFeedback()
                    onTapTakePhoto()
                }
                .disabled(remainingAttachmentSlots == 0)
            }
        } label: {
            RemodexIcon.image(systemName: "plus")
                .font(metaTextFont)
                .fontWeight(.regular)
                .frame(width: plusTapTargetSide, height: plusTapTargetSide)
                .contentShape(Capsule())
        }
        .tint(metaLabelColor)
        .disabled(isComposerInteractionLocked)
        .accessibilityLabel("Composer options")
    }

    private var planModeIndicator: some View {
        HStack(spacing: 5) {
            RemodexIcon.image(systemName: "checklist")
                .font(metaSymbolFont)
            Text("Plan")
                .font(metaTextFont)
                .fontWeight(.regular)
                .lineLimit(1)
        }
        .padding(.vertical, metaVerticalPadding)
        .padding(.horizontal, 4)
        .foregroundStyle(Color(.plan))
    }

    // Toggling Fast Mode from the plus menu mirrors the runtime speed menu without adding another visible pill.
    private func toggleFastMode() {
        runtimeActions.selectServiceTier(runtimeState.isSelectedServiceTier(.fast) ? nil : .fast)
    }

    private var fastModePlusMenuIconName: String {
        runtimeState.isSelectedServiceTier(.fast) ? "bolt.fill" : "bolt"
    }

    // Mirrors the bridge-provided runtime capability instead of guessing from the model name.
    private func modelSupportsFastMode(_ model: CodexModelOption) -> Bool {
        return model.supportsServiceTier(.fast)
    }

    private var queueBadge: some View {
        HStack(spacing: 3) {
            if isQueuePaused {
                RemodexIcon.image(systemName: "pause.fill")
                    .font(AppFont.system(size: 8, weight: .bold))
            }
            Text("\(queuedCount)")
                .font(AppFont.caption2(weight: .bold))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            Capsule().fill(isQueuePaused ? Color(.systemGray3) : Color(.systemGray4))
        )
    }
}

// Keeps the SwiftUI Menu from rebuilding during unrelated thread-sync updates.
private struct ComposerRuntimeMenuControl: View, Equatable {
    let orderedModelOptions: [CodexModelOption]
    let selectedModelID: String?
    let selectedModelTitle: String
    let isLoadingModels: Bool
    let isRuntimeSelectionLoading: Bool
    let runtimeState: TurnComposerRuntimeState
    let runtimeActions: TurnComposerRuntimeActions
    @Binding var showsAllModelsSheet: Bool

    private let metaLabelColor = Color(.secondaryLabel)
    private var metaTextFont: Font { AppFont.subheadline() }
    private var metaSymbolFont: Font { AppFont.system(size: 11, weight: .regular) }
    private var metaChevronFont: Font { AppFont.system(size: 9, weight: .regular) }

    static func == (lhs: ComposerRuntimeMenuControl, rhs: ComposerRuntimeMenuControl) -> Bool {
        lhs.orderedModelOptions == rhs.orderedModelOptions
            && lhs.selectedModelID == rhs.selectedModelID
            && lhs.selectedModelTitle == rhs.selectedModelTitle
            && lhs.isLoadingModels == rhs.isLoadingModels
            && lhs.isRuntimeSelectionLoading == rhs.isRuntimeSelectionLoading
            && lhs.runtimeState == rhs.runtimeState
    }

    // Renders one consolidated runtime pill backed by a real UIKit UIMenu so we
    // can use hierarchical Model / Intelligence / Speed rows with subtitles
    // without hitting SwiftUI nested-Menu glitches.
    var body: some View {
        UIKitMenuButton {
            composerMenuLabel(
                modelPart: modelLabelPart,
                effortPart: effortLabelPart,
                leadingImageName: runtimeState.showsSpeedBadgeInModelMenu ? "bolt.fill" : nil
            )
        } menu: {
            TurnComposerRuntimeUIKitMenuBuilder.makeMenu(
                .init(
                    runtimeState: runtimeState,
                    runtimeActions: runtimeActions,
                    orderedModelOptions: orderedModelOptions,
                    selectedModelID: selectedModelID,
                    selectedModelTitle: selectedModelTitle,
                    isLoadingModels: isLoadingModels,
                    isRuntimeSelectionLoading: isRuntimeSelectionLoading,
                    featuredModelIdentifiers: Self.featuredModelIdentifiers,
                    onRequestAllModelsSheet: {
                        // Defer to the next runloop so the menu dismissal
                        // animation isn't fighting the sheet presentation.
                        DispatchQueue.main.async {
                            showsAllModelsSheet = true
                        }
                    }
                )
            )
        }
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
        .tint(metaLabelColor)
    }

    // Split label parts so the model name and effort can carry different foreground styles.
    private var modelLabelPart: String {
        if selectedModelID == nil {
            return isRuntimeSelectionLoading ? "Loading…" : "Select model"
        }
        return compactModelTitle
    }

    private var effortLabelPart: String? {
        guard selectedModelID != nil else { return nil }
        return runtimeState.selectedReasoningTitle
    }

    // Keeps the family suffix visible while shortening the common GPT prefix.
    private var compactModelTitle: String {
        let stripped: String
        if selectedModelTitle.lowercased().hasPrefix("gpt-") {
            stripped = String(selectedModelTitle.dropFirst("GPT-".count))
        } else {
            stripped = selectedModelTitle
        }
        return stripped.replacingOccurrences(of: "-", with: " ")
    }

    // Identifiers pinned to the top of the model submenu; the rest are reachable
    // via "Other models…" so the menu stays glanceable as the list grows.
    private static let featuredModelIdentifiers: Set<String> = [
        "gpt-5.5",
        "gpt-5.4",
    ]

    private func composerMenuLabel(
        modelPart: String,
        effortPart: String?,
        leadingImageName: String?
    ) -> some View {
        HStack(spacing: 6) {
            if let leadingImageName {
                RemodexIcon.image(systemName: leadingImageName)
                    .font(metaSymbolFont)
                    .foregroundStyle(Color.primary)
            }

            titleText(modelPart: modelPart, effortPart: effortPart)
                .font(metaTextFont)
                .fontWeight(.regular)
                .lineLimit(1)

            RemodexIcon.image(systemName: "chevron.down")
                .font(metaChevronFont)
                .foregroundStyle(metaLabelColor)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .fixedSize(horizontal: true, vertical: false)
        .contentShape(Rectangle())
    }

    // Concatenated Text lets each segment carry its own foreground style.
    private func titleText(modelPart: String, effortPart: String?) -> Text {
        let model = Text(modelPart).foregroundStyle(Color.primary)
        guard let effortPart, !effortPart.isEmpty else { return model }
        return model
            + Text(" ")
            + Text(effortPart).foregroundStyle(.tertiary)
    }
}

// Full-list model picker shown when the user taps "See all models…" inside the
// runtime menu. Lives in a sheet so it sidesteps the SwiftUI nested-Menu bug
// while still keeping the runtime pill compact.
private struct AllModelsSheet: View {
    let models: [CodexModelOption]
    let selectedModelID: String?
    let isLoadingModels: Bool
    let modelSupportsFastMode: (CodexModelOption) -> Bool
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if isLoadingModels {
                    ProgressView("Loading models…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if models.isEmpty {
                    ContentUnavailableView {
                        RemodexIcon.label("No models available", systemName: "square.stack.3d.up.slash")
                    } description: {
                        Text("Reconnect to your local Codex bridge to refresh the model list.")
                    }
                } else {
                    List {
                        Section {
                            ForEach(models, id: \.id) { model in
                                Button {
                                    onSelect(model.id)
                                } label: {
                                    modelRow(for: model)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Choose model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func modelRow(for model: CodexModelOption) -> some View {
        let title = TurnComposerMetaMapper.modelTitle(for: model)
        HStack(alignment: .top, spacing: 12) {
            RemodexIcon.image(systemName: model.id == selectedModelID ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 18))
                .foregroundStyle(model.id == selectedModelID ? Color.accentColor : Color(.tertiaryLabel))
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(AppFont.body(weight: .medium))
                        .foregroundStyle(Color(.label))
                    if modelSupportsFastMode(model) {
                        RemodexIcon.image(systemName: CodexServiceTier.fast.iconName)
                            .font(AppFont.system(size: 11, weight: .regular))
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                }
                if !model.description.isEmpty {
                    Text(model.description)
                        .font(AppFont.subheadline())
                        .foregroundStyle(Color(.secondaryLabel))
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

// Keeps the mic button state and styling decisions outside the layout code.
struct TurnComposerVoiceButtonPresentation {
    let systemImageName: String
    let foregroundColor: Color
    let backgroundColor: Color
    let accessibilityLabel: String
    let isDisabled: Bool
    let showsProgress: Bool
    let hasCircleBackground: Bool
}
