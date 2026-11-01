// KeyStore.swift — Zugangsdaten und Geräteschlüssel im Schlüsselbund.
//
// Alles mit kSecAttrAccessibleWhenUnlockedThisDeviceOnly: nur bei entsperrtem
// Gerät lesbar, nicht in Backups, nicht auf andere Geräte übertragbar. Der
// Secure-Enclave-Schlüssel liegt hier nur als verschlüsselte Hülle, die allein
// die Secure Enclave dieses iPhones öffnen kann.

import Foundation
import Security

public enum KeyStore {
    static let service = "de.dvhub.app.link"
    static let systemsAccount = "systems.v1"

    private struct KeyBlob: Codable {
        let kind: String   // "se" | "sw"
        let data: String   // base64url
    }

    // MARK: Roh-Zugriff

    static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    static func write(_ data: Data, account: String) throws {
        let q = baseQuery(account)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            attrs.forEach { add[$0.key] = $0.value }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw LinkError.keychain(status) }
    }

    static func read(account: String) throws -> Data? {
        var q = baseQuery(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw LinkError.keychain(status) }
        return out as? Data
    }

    static func delete(account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
    }

    // MARK: Anlagen

    public static func loadSystems() throws -> [LinkCredentials] {
        guard let data = try read(account: systemsAccount) else { return [] }
        return try JSONDecoder().decode([LinkCredentials].self, from: data)
    }

    public static func saveSystems(_ systems: [LinkCredentials]) throws {
        try write(try JSONEncoder().encode(systems), account: systemsAccount)
    }

    // MARK: Geräteschlüssel

    /// Neuer Geräteschlüssel für eine Kopplung: Secure Enclave, wenn vorhanden.
    public static func createSigner() throws -> (signer: LinkSigner, keyRef: String) {
        let ref = "key." + UUID().uuidString
        if SecureEnclaveSigner.isAvailable {
            let se = try SecureEnclaveSigner()
            try write(try JSONEncoder().encode(KeyBlob(kind: "se", data: Base64URL.encode(se.dataRepresentation))), account: ref)
            return (se, ref)
        }
        let sw = SoftwareSigner()
        try write(try JSONEncoder().encode(KeyBlob(kind: "sw", data: Base64URL.encode(sw.rawScalar))), account: ref)
        return (sw, ref)
    }

    public static func loadSigner(_ keyRef: String) throws -> LinkSigner {
        guard let data = try read(account: keyRef) else { throw LinkError.keychain(errSecItemNotFound) }
        let blob = try JSONDecoder().decode(KeyBlob.self, from: data)
        let raw = try Base64URL.decode(blob.data)
        switch blob.kind {
        case "se": return try SecureEnclaveSigner(dataRepresentation: raw)
        default: return try SoftwareSigner(rawScalar: raw)
        }
    }

    public static func isSecureEnclaveKey(_ keyRef: String) -> Bool {
        guard let data = try? read(account: keyRef), let blob = try? JSONDecoder().decode(KeyBlob.self, from: data) else { return false }
        return blob.kind == "se"
    }

    public static func deleteKey(_ keyRef: String) { delete(account: keyRef) }
}
