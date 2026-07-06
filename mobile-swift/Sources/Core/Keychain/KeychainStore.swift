import Dependencies
import DependenciesMacros
import Foundation
import Security

public enum TokenKey: String, Sendable, CaseIterable {
    case accessToken
    case refreshToken
    case agentToken
}

public enum KeychainError: Error, Equatable {
    case unexpectedStatus(OSStatus)
    case dataConversion
}

@DependencyClient
public struct KeychainStore: Sendable {
    public var save: @Sendable (_ value: String, _ key: TokenKey) throws -> Void
    public var load: @Sendable (_ key: TokenKey) throws -> String?
    public var delete: @Sendable (_ key: TokenKey) throws -> Void
}

private func keychainBaseQuery(service: String, key: TokenKey) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: key.rawValue,
    ]
}

extension KeychainStore {
    public static func live(service: String = "com.ourchat.ios.tokens") -> KeychainStore {
        KeychainStore(
            save: { value, key in
                let data = Data(value.utf8)
                let updateStatus = SecItemUpdate(
                    keychainBaseQuery(service: service, key: key) as CFDictionary,
                    [kSecValueData as String: data] as CFDictionary
                )
                if updateStatus == errSecItemNotFound {
                    var addQuery = keychainBaseQuery(service: service, key: key)
                    addQuery[kSecValueData as String] = data
                    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
                    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
                    guard addStatus == errSecSuccess else {
                        throw KeychainError.unexpectedStatus(addStatus)
                    }
                } else if updateStatus != errSecSuccess {
                    throw KeychainError.unexpectedStatus(updateStatus)
                }
            },
            load: { key in
                var query = keychainBaseQuery(service: service, key: key)
                query[kSecReturnData as String] = true
                query[kSecMatchLimit as String] = kSecMatchLimitOne
                var item: CFTypeRef?
                let status = SecItemCopyMatching(query as CFDictionary, &item)
                if status == errSecItemNotFound {
                    return nil
                }
                guard status == errSecSuccess else {
                    throw KeychainError.unexpectedStatus(status)
                }
                guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
                    throw KeychainError.dataConversion
                }
                return value
            },
            delete: { key in
                let status = SecItemDelete(keychainBaseQuery(service: service, key: key) as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else {
                    throw KeychainError.unexpectedStatus(status)
                }
            }
        )
    }

    public static func inMemory() -> KeychainStore {
        let storage = InMemoryKeychainStorage()
        return KeychainStore(
            save: { value, key in storage.set(value, for: key.rawValue) },
            load: { key in storage.get(key.rawValue) },
            delete: { key in storage.set(nil, for: key.rawValue) }
        )
    }
}

private final class InMemoryKeychainStorage: @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    func set(_ value: String?, for key: String) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }

    func get(_ key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }
}

extension KeychainStore: DependencyKey {
    public static let liveValue = KeychainStore.live()
}

extension DependencyValues {
    public var keychain: KeychainStore {
        get { self[KeychainStore.self] }
        set { self[KeychainStore.self] = newValue }
    }
}
