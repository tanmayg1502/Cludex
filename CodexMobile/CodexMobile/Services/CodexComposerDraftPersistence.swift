// FILE: CodexComposerDraftPersistence.swift
// Purpose: Persists unsent per-thread composer drafts, including local image payloads.
// Layer: Service Persistence
// Exports: CodexComposerDraftPersistence
// Depends on: Foundation, CryptoKit, SecureStore, TurnComposerLocalDraft

import CryptoKit
import Foundation

nonisolated struct CodexComposerDraftPersistence {
    private let fileName = "codex-composer-drafts-v1.bin"

    // Loads locally saved composer drafts. Corrupt or undecryptable stores safely fall back to empty.
    func load() -> [String: TurnComposerLocalDraft] {
        guard let data = try? Data(contentsOf: storeURL),
              let decrypted = decryptPersistedPayload(data),
              let value = try? JSONDecoder().decode([String: TurnComposerLocalDraft].self, from: decrypted) else {
            return [:]
        }

        return value.filter { !$0.value.isEmpty }
    }

    // Saves the current non-empty draft map atomically.
    func save(_ value: [String: TurnComposerLocalDraft]) {
        let sanitized = value.filter { !$0.value.isEmpty }
        guard !sanitized.isEmpty else {
            try? FileManager.default.removeItem(at: storeURL)
            return
        }

        guard let plaintext = try? JSONEncoder().encode(sanitized),
              let data = encryptPersistedPayload(plaintext) else {
            return
        }

        ensureParentDirectoryExists(for: storeURL)
        try? data.write(to: storeURL, options: [.atomic])
    }

    private var storeURL: URL {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        let bundleID = Bundle.main.bundleIdentifier ?? "com.codexmobile.app"
        return base
            .appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }

    private func ensureParentDirectoryExists(for fileURL: URL) {
        let directory = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func encryptPersistedPayload(_ plaintext: Data) -> Data? {
        let key = localHistoryKey()
        let sealedBox = try? AES.GCM.seal(plaintext, using: key)
        return sealedBox?.combined
    }

    private func decryptPersistedPayload(_ encryptedData: Data) -> Data? {
        let key = localHistoryKey()
        guard let sealedBox = try? AES.GCM.SealedBox(combined: encryptedData) else {
            return nil
        }
        return try? AES.GCM.open(sealedBox, using: key)
    }

    private func localHistoryKey() -> SymmetricKey {
        if let storedKey = SecureStore.readData(for: CodexSecureKeys.messageHistoryKey) {
            return SymmetricKey(data: storedKey)
        }

        let newKey = SymmetricKey(size: .bits256)
        let keyData = newKey.withUnsafeBytes { Data($0) }
        SecureStore.writeData(keyData, for: CodexSecureKeys.messageHistoryKey)
        return newKey
    }
}
