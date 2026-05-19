// FILE: CodexServiceThreadListTests.swift
// Purpose: Verifies thread-list fetch shape and local ordering so sidebar results stay recent-activity ordered.
// Layer: Unit Test
// Exports: CodexServiceThreadListTests
// Depends on: XCTest, CodexMobile

import XCTest
@testable import CodexMobile

@MainActor
final class CodexServiceThreadListTests: XCTestCase {
    private static var retainedServices: [CodexService] = []

    func testListThreadsRequestsCappedActiveThreadsAndAppServerSourceKinds() async throws {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true

        var activeRequestParams: RPCObject?
        var archivedRequestParams: RPCObject?

        service.requestTransportOverride = { method, params in
            guard method == "thread/list" else {
                return RPCMessage(
                    id: .string(UUID().uuidString),
                    result: .object([:]),
                    includeJSONRPC: false
                )
            }

            let isArchived = params?.objectValue?["archived"]?.boolValue ?? false
            if isArchived {
                archivedRequestParams = params?.objectValue
            } else {
                activeRequestParams = params?.objectValue
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "threads": .array([]),
                ]),
                includeJSONRPC: false
            )
        }

        try await service.listThreads()

        XCTAssertEqual(activeRequestParams?["limit"]?.intValue, 70)
        XCTAssertEqual(archivedRequestParams?["limit"]?.intValue, 10)
        XCTAssertEqual(archivedRequestParams?["archived"]?.boolValue, true)
        XCTAssertEqual(
            activeRequestParams?["sourceKinds"]?.arrayValue?.compactMap(\.stringValue),
            ["cli", "vscode", "appServer", "exec", "unknown"]
        )
    }

    func testListThreadsPublishesActiveThreadsBeforeArchivedFetchCompletes() async throws {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true

        var archivedContinuation: CheckedContinuation<RPCMessage, Error>?

        service.requestTransportOverride = { method, params in
            guard method == "thread/list" else {
                return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
            }

            let isArchived = params?.objectValue?["archived"]?.boolValue ?? false
            if isArchived {
                return try await withCheckedThrowingContinuation { continuation in
                    archivedContinuation = continuation
                }
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "threads": .array([
                        .object([
                            "id": .string("thread-active"),
                            "title": .string("Active thread"),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        }

        let listTask = Task { @MainActor in
            try await service.listThreads()
        }

        for _ in 0..<100 where service.threads.first?.id != "thread-active" {
            await Task.yield()
        }

        XCTAssertEqual(service.threads.map(\.id), ["thread-active"])
        XCTAssertTrue(service.isLoadingThreads)

        for _ in 0..<100 where archivedContinuation == nil {
            await Task.yield()
        }

        guard let archivedContinuation else {
            XCTFail("Expected archived thread/list request to be in flight")
            listTask.cancel()
            return
        }

        archivedContinuation.resume(
            returning: RPCMessage(
                id: .string(UUID().uuidString),
                result: .object([
                    "threads": .array([
                        .object([
                            "id": .string("thread-archived"),
                            "title": .string("Archived thread"),
                        ]),
                    ]),
                ]),
                includeJSONRPC: false
            )
        )

        try await listTask.value

        XCTAssertTrue(service.threads.contains(where: { $0.id == "thread-active" }))
        XCTAssertTrue(service.threads.contains(where: { $0.id == "thread-archived" }))
        XCTAssertFalse(service.isLoadingThreads)
    }

    func testRealtimeSyncKeepsThreadListRequestsCapped() async {
        let service = makeService()
        service.isConnected = true
        service.isInitialized = true

        var activeRequestParams: RPCObject?
        var archivedRequestParams: RPCObject?

        service.requestTransportOverride = { method, params in
            guard method == "thread/list" else {
                return RPCMessage(id: .string(UUID().uuidString), result: .object([:]), includeJSONRPC: false)
            }

            let isArchived = params?.objectValue?["archived"]?.boolValue ?? false
            if isArchived {
                archivedRequestParams = params?.objectValue
            } else {
                activeRequestParams = params?.objectValue
            }

            return RPCMessage(
                id: .string(UUID().uuidString),
                result: .object(["threads": .array([])]),
                includeJSONRPC: false
            )
        }

        await service.syncThreadsList()

        XCTAssertEqual(activeRequestParams?["limit"]?.intValue, 70)
        XCTAssertEqual(archivedRequestParams?["limit"]?.intValue, 10)
    }

    func testSortThreadsUsesUpdatedAtBeforeCreatedAtFallback() {
        let service = makeService()
        let laterByUpdatedAt = CodexThread(
            id: "later-by-updated-at",
            createdAt: Date(timeIntervalSince1970: 10),
            updatedAt: Date(timeIntervalSince1970: 50)
        )
        let laterByCreatedAt = CodexThread(
            id: "later-by-created-at",
            createdAt: Date(timeIntervalSince1970: 100),
            updatedAt: nil
        )
        let oldestThread = CodexThread(
            id: "oldest-thread",
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: nil
        )

        let sorted = service.sortThreads([oldestThread, laterByCreatedAt, laterByUpdatedAt])

        XCTAssertEqual(
            sorted.map(\.id),
            ["later-by-updated-at", "later-by-created-at", "oldest-thread"]
        )
    }

    private func makeService() -> CodexService {
        let suiteName = "CodexServiceThreadListTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)
        let service = CodexService(defaults: defaults)
        Self.retainedServices.append(service)
        return service
    }
}
