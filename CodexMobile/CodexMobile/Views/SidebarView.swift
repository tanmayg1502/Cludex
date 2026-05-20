// FILE: SidebarView.swift
// Purpose: Orchestrates the sidebar experience with modular presentation components.
//          Top: brand toolbar. Body: native scroll with search + project / chat list.
//          Bottom: SidebarBottomActionBar with the primary Chat FAB (glass on
//          iOS 26, accent pill on iOS 18).
// Layer: View
// Exports: SidebarView
// Depends on: CodexService, SidebarHeaderView, SidebarThreadListView,
//             SidebarBottomActionBar, SidebarSearchField

import SwiftUI

struct SidebarView: View {
    @Environment(CodexService.self) private var codex

    @Binding var selectedThread: CodexThread?
    @Binding var isSearchActive: Bool
    var showsInlineCloseButton: Bool = false
    var isVisible: Bool = true

    let onClose: () -> Void
    let onOpenSettings: () -> Void
    let onOpenTerminal: () -> Void
    let onNewChatCreationStateChange: (Bool) -> Void
    let onOpenThread: (CodexThread) -> Void
    let onReconnect: () -> Void
    let onScanNewPairing: () -> Void
    let onPairWithCode: () -> Void
    let onForgetPair: () -> Void

    @State private var searchText = ""
    @State private var isCreatingThread = false
    @State private var pendingTopAction: SidebarTopAction? = nil
    @State private var groupedThreads: [SidebarThreadGroup] = []
    @State private var activeSidebarSheet: SidebarPresentedSheet?
    @State private var projectGroupPendingArchive: SidebarThreadGroup? = nil
    @State private var projectGroupPendingDeletion: SidebarThreadGroup? = nil
    @State private var threadPendingDeletion: CodexThread? = nil
    @State private var createThreadErrorMessage: String? = nil
    @State private var cachedRunBadges: [String: CodexThreadRunBadgeState] = [:]
    @State private var lastGroupedThreadsFingerprint: Int = 0
    @State private var lastBadgeFingerprint: Int = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SidebarHeaderView(
                showsCloseButton: showsInlineCloseButton,
                onClose: onClose,
                overflowActions: overflowMenuActions
            )

            threadListWithBottomBar
        }
        .frame(maxHeight: .infinity)
        .background(Color(.systemBackground))
        .task {
            debugSidebarLog("task start visible=\(isVisible) threadCount=\(codex.threads.count)")
            rebuildGroupedThreads()
            rebuildCachedSidebarState()
            if codex.isConnected, codex.threads.isEmpty {
                await refreshThreads()
            }
        }
        .onChange(of: codex.threads) { _, _ in
            debugSidebarLog(
                "threads changed while \(isVisible ? "visible" : "hidden-prewarmed") "
                    + "threadCount=\(codex.threads.count)"
            )
            rebuildGroupedThreads()
            rebuildCachedSidebarState()
        }
        .onChange(of: searchText) { _, _ in
            debugSidebarLog("search changed queryLength=\(searchText.count)")
            rebuildGroupedThreads()
        }
        .onChange(of: codex.pinnedThreadIDs) { _, _ in
            debugSidebarLog("pinned threads changed count=\(codex.pinnedThreadIDs.count)")
            rebuildGroupedThreads()
        }
        // Deferred to the next runloop tick so rebuilding the cache `@State`
        // does not trigger another body re-evaluation inside the same frame
        // (which previously cascaded with iOS 26 `safeAreaBar`'s internal
        // OnScrollGeometryChange and logged "tried to update multiple times
        // per frame" warnings).
        .onChange(of: badgeFingerprint) { _, _ in
            debugSidebarLog("badge fingerprint changed visible=\(isVisible)")
            Task { @MainActor in rebuildCachedRunBadges() }
        }
        .onChange(of: isVisible) { _, visible in
            debugSidebarLog("visibility changed visible=\(visible)")
        }
        .overlay {
            if SidebarThreadsLoadingPresentation.shouldShowOverlay(
                isLoadingThreads: codex.isLoadingThreads,
                threadCount: codex.threads.count
            ) {
                ProgressView()
                    .padding()
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .sheet(item: $activeSidebarSheet) { sheet in
            sidebarSheetContent(sheet)
        }
        .confirmationDialog(
            "Archive \"\(projectGroupPendingArchive?.label ?? "project")\"?",
            isPresented: Binding(
                get: { projectGroupPendingArchive != nil },
                set: { if !$0 { projectGroupPendingArchive = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Archive Project") {
                archivePendingProjectGroup()
            }
            Button("Cancel", role: .cancel) {
                projectGroupPendingArchive = nil
            }
        } message: {
            Text("All active chats in this project will be archived.")
        }
        .alert(
            "Remove \"\(projectGroupPendingDeletion?.label ?? "project")\" from this phone?",
            isPresented: Binding(
                get: { projectGroupPendingDeletion != nil },
                set: { if !$0 { projectGroupPendingDeletion = nil } }
            )
        ) {
            Button("Remove from Phone", role: .destructive) {
                deletePendingProjectGroupLocally()
            }
            Button("Cancel", role: .cancel) {
                projectGroupPendingDeletion = nil
            }
        } message: {
            Text("Chats for this project will be deleted only from Remodex on this phone. Nothing is removed from your computer or Codex observer.")
        }
        .alert(
            "Remove \"\(threadPendingDeletion?.displayTitle ?? "conversation")\" from this phone?",
            isPresented: Binding(
                get: { threadPendingDeletion != nil },
                set: { if !$0 { threadPendingDeletion = nil } }
            )
        ) {
            Button("Remove from Phone", role: .destructive) {
                if let thread = threadPendingDeletion {
                    if selectedThread?.id == thread.id {
                        selectedThread = nil
                    }
                    codex.deleteThreadLocally(thread.id)
                }
                threadPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) {
                threadPendingDeletion = nil
            }
        } message: {
            Text("This only removes the chat from Remodex on this phone. Nothing is removed from your computer or Codex observer.")
        }
        .alert(
            "Action failed",
            isPresented: Binding(
                get: { createThreadErrorMessage != nil },
                set: { if !$0 { createThreadErrorMessage = nil } }
            ),
            actions: {
                Button("OK", role: .cancel) {
                    createThreadErrorMessage = nil
                }
            },
            message: {
                Text(createThreadErrorMessage ?? "Please try again.")
            }
        )
    }

    // MARK: - Actions

    private func refreshThreads() async {
        guard codex.isConnected else { return }
        let startedAt = Date()
        debugSidebarLog("refreshThreads start threadCount=\(codex.threads.count)")
        do {
            try await codex.listThreads()
            debugSidebarLog(
                "refreshThreads success durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                    + "threadCount=\(codex.threads.count)"
            )
        } catch {
            debugSidebarLog(
                "refreshThreads failed durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                    + "error=\(error.localizedDescription)"
            )
            // Error stored in CodexService.
        }
    }

    // Shows a native sheet so folder names and full paths stay readable on small screens.
    private func handleNewChatButtonTap() {
        activeSidebarSheet = .newChatProjectPicker
    }

    // Starts a chat without a working directory (cwd == nil) directly from the sidebar row.
    private func handleQuickChatTap() {
        pendingTopAction = .quickChat
        handleNewChatTap(preferredProjectPath: nil)
    }

    // Opens the local folder browser so the user can register a new project root.
    private func handleNewProjectTap() {
        presentLocalFolderBrowser()
    }

    private func presentLocalFolderBrowser() {
        activeSidebarSheet = .localFolderBrowser
    }

    private func handleNewChatTap(preferredProjectPath: String?) {
        createThreadErrorMessage = nil
        isCreatingThread = true
        onNewChatCreationStateChange(true)
        prepareSidebarForChatNavigation()
        Task { @MainActor in
            defer {
                isCreatingThread = false
                pendingTopAction = nil
                onNewChatCreationStateChange(false)
            }

            do {
                let thread = try await WorktreeFlowCoordinator.startNewLocalChat(
                    preferredProjectPath: preferredProjectPath,
                    codex: codex
                )
                onOpenThread(thread)
            } catch {
                guard let message = codex.userFacingTurnErrorMessageForFooter(from: error) else { return }
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a chat right now." : message
            }
        }
    }

    private func handleNewClaudeChatTap(preferredProjectPath: String?) {
        createThreadErrorMessage = nil
        isCreatingThread = true
        onNewChatCreationStateChange(true)
        prepareSidebarForChatNavigation()
        Task { @MainActor in
            defer {
                isCreatingThread = false
                pendingTopAction = nil
                onNewChatCreationStateChange(false)
            }

            do {
                let thread = try await codex.startThreadIfReady(
                    preferredProjectPath: preferredProjectPath,
                    agentId: "claude-code"
                )
                onOpenThread(thread)
            } catch {
                guard let message = codex.userFacingTurnErrorMessageForFooter(from: error) else { return }
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a Claude chat right now." : message
            }
        }
    }

    private func handleNewWorktreeChatTap(preferredProjectPath: String) {
        createThreadErrorMessage = nil
        isCreatingThread = true
        onNewChatCreationStateChange(true)
        prepareSidebarForChatNavigation()
        Task { @MainActor in
            defer {
                isCreatingThread = false
                pendingTopAction = nil
                onNewChatCreationStateChange(false)
            }

            do {
                let thread = try await WorktreeFlowCoordinator.startNewWorktreeChat(
                    preferredProjectPath: preferredProjectPath,
                    codex: codex
                )
                onOpenThread(thread)
            } catch {
                guard let message = codex.userFacingTurnErrorMessageForFooter(from: error) else { return }
                codex.lastErrorMessage = message
                createThreadErrorMessage = message.isEmpty ? "Unable to create a worktree chat right now." : message
            }
        }
    }

    private func selectThread(_ thread: CodexThread) {
        debugSidebarLog("selectThread id=\(thread.id) title=\(thread.displayTitle)")
        prepareSidebarForChatNavigation()
        onOpenThread(thread)
    }

    private func openSettings() {
        searchText = ""
        isSearchActive = false
        onOpenSettings()
    }

    private func openTerminal() {
        searchText = ""
        isSearchActive = false
        onOpenTerminal()
    }

    // Clears sidebar-only input state before navigation so full-width search mode cannot hold the drawer open.
    private func prepareSidebarForChatNavigation() {
        searchText = ""
        isSearchActive = false
        onClose()
    }

    // Archives every live chat in the selected project group and clears the current selection if needed.
    private func archivePendingProjectGroup() {
        guard let group = projectGroupPendingArchive else { return }

        let threadIDs = SidebarThreadGrouping.liveThreadIDsForProjectGroup(group, in: codex.threads)
        let selectedThreadWasArchived = selectedThread.map { selected in
            threadIDs.contains(selected.id)
        } ?? false

        _ = codex.archiveThreadGroup(threadIDs: threadIDs)

        if selectedThreadWasArchived {
            selectedThread = codex.threads.first(where: { thread in
                thread.syncState == .live && !threadIDs.contains(thread.id)
            })
        }

        projectGroupPendingArchive = nil
    }

    // Removes every local chat for the selected project while leaving the desktop runtime untouched.
    private func deletePendingProjectGroupLocally() {
        guard let group = projectGroupPendingDeletion else { return }

        let threadIDs = SidebarThreadGrouping.allThreadIDsForProjectGroup(group, in: codex.threads)
        let selectedThreadWasDeleted = selectedThread.map { selected in
            threadIDs.contains(selected.id)
        } ?? false

        _ = codex.deleteLocalThreadGroup(threadIDs: threadIDs)

        if selectedThreadWasDeleted {
            selectedThread = codex.threads.first { thread in
                thread.syncState == .live && !threadIDs.contains(thread.id)
            }
        }

        projectGroupPendingDeletion = nil
    }

    // Rebuilds sidebar sections only when the source thread array changes.
    private func rebuildGroupedThreads() {
        let startedAt = Date()
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let source: [CodexThread]
        if query.isEmpty {
            source = codex.threads
        } else {
            source = codex.threads.filter {
                $0.displayTitle.localizedCaseInsensitiveContains(query)
                || ($0.preview?.localizedCaseInsensitiveContains(query) ?? false)
                || $0.projectDisplayName.localizedCaseInsensitiveContains(query)
                || ($0.normalizedProjectPath?.localizedCaseInsensitiveContains(query) ?? false)
            }
        }
        let fingerprint = groupingFingerprint(query: query, source: source)
        guard fingerprint != lastGroupedThreadsFingerprint else { return }
        lastGroupedThreadsFingerprint = fingerprint
        groupedThreads = SidebarThreadGrouping.makeGroups(from: source, pinnedThreadIDs: codex.pinnedThreadIDs)
        debugSidebarLog(
            "rebuildGroupedThreads durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "queryLength=\(query.count) sourceCount=\(source.count) groupCount=\(groupedThreads.count)"
        )
    }

    private func groupingFingerprint(query: String, source: [CodexThread]) -> Int {
        var hasher = Hasher()
        hasher.combine(query)
        hasher.combine(codex.pinnedThreadIDs)
        for thread in source {
            hasher.combine(thread)
        }
        return hasher.finalize()
    }

    // Cheap fingerprint for run badge state — changes when running/ready/failed sets change.
    private var badgeFingerprint: Int {
        var hasher = Hasher()
        for thread in codex.threads {
            hasher.combine(thread.id)
            if let badge = codex.threadRunBadgeState(for: thread.id) {
                hasher.combine(badge)
            }
        }
        return hasher.finalize()
    }

    private func rebuildCachedSidebarState() {
        let startedAt = Date()
        rebuildCachedRunBadges()
        debugSidebarLog(
            "rebuildCachedSidebarState durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "runBadges=\(cachedRunBadges.count)"
        )
    }

    private func rebuildCachedRunBadges() {
        let fp = badgeFingerprint
        guard fp != lastBadgeFingerprint else { return }
        let startedAt = Date()
        lastBadgeFingerprint = fp

        var byThreadID: [String: CodexThreadRunBadgeState] = [:]
        for thread in codex.threads {
            if let state = codex.threadRunBadgeState(for: thread.id) {
                byThreadID[thread.id] = state
            }
        }
        cachedRunBadges = byThreadID
        debugSidebarLog(
            "rebuildCachedRunBadges durationMs=\(Int(Date().timeIntervalSince(startedAt) * 1000)) "
                + "threadCount=\(codex.threads.count) cached=\(cachedRunBadges.count)"
        )
    }

    // Keeps the chooser in sync with the same project buckets shown in the sidebar.
    private var newChatProjectChoices: [SidebarProjectChoice] {
        SidebarThreadGrouping.makeProjectChoices(from: codex.threads)
    }

    private var canCreateThread: Bool {
        codex.isConnected && codex.isInitialized
    }

    private var shouldShowConnectionRecovery: Bool {
        !codex.isConnected
    }

    private var isConnecting: Bool {
        switch codex.connectionPhase {
        case .connecting, .loadingChats, .syncing:
            return true
        case .offline, .connected:
            return false
        }
    }

    private var sidebarConnectionRecoveryView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(isConnecting ? Color.orange : Color(.tertiaryLabel))
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)

                VStack(alignment: .leading, spacing: 3) {
                    Text(isConnecting ? "Reconnecting" : "Saved Computer")
                        .font(AppFont.caption(weight: .semibold))
                        .foregroundStyle(.secondary)

                    Text(connectionRecoverySummary)
                        .font(AppFont.subheadline(weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Button(action: primaryConnectionRecoveryAction) {
                HStack(spacing: 8) {
                    if isConnecting {
                        ProgressView()
                            .controlSize(.small)
                    }

                    Text(primaryConnectionRecoveryTitle)
                        .font(AppFont.subheadline(weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .foregroundStyle(Color(.systemBackground))
                .background(Color.primary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isConnecting)

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Button("New QR Code", action: onScanNewPairing)
                    Button("Pair with Code", action: onPairWithCode)
                }

                if codex.hasSavedConnectionState {
                    Button("Forget Pair", role: .destructive, action: onForgetPair)
                }
            }
            .font(AppFont.caption(weight: .semibold))
            .foregroundStyle(.secondary)
            .buttonStyle(.plain)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }

    private var connectionRecoverySummary: String {
        if let error = codex.lastErrorMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            return error
        }

        if let name = codex.trustedPairPresentation?.name,
           !name.isEmpty {
            return "Connect to \(name), or pair with a fresh code."
        }

        if !codex.hasSavedConnectionState {
            return "Scan the QR code from your Mac or enter the pairing code."
        }

        return "Connect to your saved Mac, or pair with a fresh code."
    }

    private var primaryConnectionRecoveryTitle: String {
        if isConnecting {
            return "Reconnecting..."
        }

        return codex.hasReconnectCandidate ? "Reconnect" : "Scan QR Code"
    }

    private func primaryConnectionRecoveryAction() {
        if codex.hasReconnectCandidate {
            onReconnect()
        } else {
            onScanNewPairing()
        }
    }

    // Wraps the thread list with the bottom action bar. `safeAreaInset` keeps
    // the glass controls in the hit-test tree; `safeAreaBar` could render the
    // iOS 26 bar while dropping taps from the Terminal pill inside the drawer.
    @ViewBuilder
    private var threadListWithBottomBar: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                SidebarSearchField(text: $searchText, isActive: $isSearchActive)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 8)

                if shouldShowConnectionRecovery {
                    sidebarConnectionRecoveryView
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)
                }

                if SidebarThreadsLoadingPresentation.shouldShowInlineStatus(
                    isLoadingThreads: codex.isLoadingThreads,
                    threadCount: codex.threads.count
                ) {
                    SidebarThreadsInlineLoadingView()
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .transition(.opacity)
                }

                threadList
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomActionBar
        }
    }

    private var threadList: some View {
        SidebarThreadListView(
            isFiltering: !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            isConnected: codex.isConnected,
            isCreatingThread: isCreatingThread,
            threads: codex.threads,
            groups: groupedThreads,
            selectedThread: selectedThread,
            bottomContentInset: 0,
            timingLabelProvider: { SidebarRelativeTimeFormatter.compactLabel(for: $0) },
            runBadgeStateByThreadID: cachedRunBadges,
            onSelectThread: selectThread,
            onCreateThreadInProjectGroup: { group in
                handleNewChatTap(preferredProjectPath: group.projectPath)
            },
            onArchiveProjectGroup: { group in
                projectGroupPendingArchive = group
            },
            onDeleteProjectGroup: { group in
                projectGroupPendingDeletion = group
            },
            onRenameThread: { thread, newName in
                codex.renameThread(thread.id, name: newName)
            },
            onPinToggleThread: { thread in
                if codex.isThreadPinned(thread.id) {
                    codex.unpinThread(thread.id)
                } else {
                    codex.pinThread(thread.id)
                }
                rebuildGroupedThreads()
            },
            onArchiveToggleThread: { thread in
                if thread.syncState == .archivedLocal {
                    codex.unarchiveThread(thread.id)
                } else {
                    codex.archiveThread(thread.id)
                    if selectedThread?.id == thread.id {
                        selectedThread = nil
                    }
                }
            },
            onDeleteThread: { thread in
                threadPendingDeletion = thread
            }
        )
        .refreshable {
            await refreshThreads()
        }
    }

    private var bottomActionBar: some View {
        SidebarBottomActionBar(
            isChatEnabled: canCreateThread,
            isCreatingThread: isCreatingThread,
            onTapChat: handleNewChatButtonTap,
            onTapTerminal: openTerminal,
            onTapOrchestrate: {
                activeSidebarSheet = .orchestrationComposer
            }
        )
    }

    private var overflowMenuActions: SidebarOverflowMenuActions {
        SidebarOverflowMenuActions(
            isEnabled: canCreateThread,
            pendingAction: pendingTopAction,
            onNewChat: handleNewChatButtonTap,
            onQuickChat: handleQuickChatTap,
            onNewProject: handleNewProjectTap,
            onOpenTerminal: openTerminal,
            onOpenSettings: openSettings
        )
    }

    // Sidebar refresh and search events can fire during gestures; logs must not mutate view state.
    private func debugSidebarLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        guard Self.isSidebarDebugLoggingEnabled else { return }
        print("[SidebarData] \(message())")
        #endif
    }
}

private extension SidebarView {
    static var isSidebarDebugLoggingEnabled: Bool { false }
}

private enum SidebarPresentedSheet: String, Identifiable {
    case newChatProjectPicker
    case localFolderBrowser
    case orchestrationComposer

    var id: String { rawValue }
}

private extension SidebarView {
    @ViewBuilder
    func sidebarSheetContent(_ sheet: SidebarPresentedSheet) -> some View {
        switch sheet {
        case .newChatProjectPicker:
            SidebarNewChatProjectPickerSheet(
                choices: newChatProjectChoices,
                onSelectProject: { projectPath in
                    activeSidebarSheet = nil
                    handleNewChatTap(preferredProjectPath: projectPath)
                },
                onSelectWorktreeProject: { projectPath in
                    activeSidebarSheet = nil
                    handleNewWorktreeChatTap(preferredProjectPath: projectPath)
                },
                onSelectWithoutProject: {
                    activeSidebarSheet = nil
                    handleNewChatTap(preferredProjectPath: nil)
                },
                onBrowseLocalFolder: {
                    presentLocalFolderBrowser()
                },
                onSelectWithClaude: { projectPath in
                    activeSidebarSheet = nil
                    handleNewClaudeChatTap(preferredProjectPath: projectPath)
                }
            )
        case .localFolderBrowser:
            SidebarLocalFolderBrowserSheet { projectPath in
                activeSidebarSheet = nil
                handleNewChatTap(preferredProjectPath: projectPath)
            }
        case .orchestrationComposer:
            OrchestrationComposerSheet()
        }
    }
}

enum SidebarThreadsLoadingPresentation {
    // Keeps pull-to-refresh from stacking a second spinner over an already populated sidebar.
    static func shouldShowOverlay(isLoadingThreads: Bool, threadCount: Int) -> Bool {
        isLoadingThreads && threadCount == 0
    }

    // Populated sidebars still need feedback while the complete metadata pass is running.
    static func shouldShowInlineStatus(isLoadingThreads: Bool, threadCount: Int) -> Bool {
        isLoadingThreads && threadCount > 0
    }
}

private struct SidebarThreadsInlineLoadingView: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Syncing chats")
                .font(AppFont.caption())
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}

// SidebarNewChatProjectPickerSheet has moved to
// Views/Sidebar/SidebarNewChatProjectPickerSheet.swift so it can carry its own
// SwiftUI #Preview without dragging in the rest of the sidebar.
