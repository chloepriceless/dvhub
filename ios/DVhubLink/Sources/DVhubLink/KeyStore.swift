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

    /// Geteilte Schlüsselbund-Gruppe (Keychain Access Group) von App und
    /// Erweiterungen, z. B. „ABCDE12345.de.dvhub.app.shared“. nil: Standardgruppe
    /// des Programms. Einmal beim Start setzen (App: `adoptSharedGroup`).
    /// Schutzklasse und Secure-Enclave-Schlüssel bleiben, wie sie sind — die
    /// Gruppe entscheidet nur, welche Programme desselben Teams den Eintrag sehen.
    nonisolated(unsafe) public static var accessGroup: String?

    // MARK: Roh-Zugriff

    static func baseQuery(_ account: String, group: String? = accessGroup) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static func write(_ data: Data, account: String) throws {
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery(account) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound, let group = accessGroup {
            // Eintrag liegt noch in der Standardgruppe der App: aktualisieren und umziehen.
            var move = attrs
            move[kSecAttrAccessGroup as String] = group
            status = SecItemUpdate(baseQuery(account, group: nil) as CFDictionary, move as CFDictionary)
        }
        if status == errSecItemNotFound {
            var add = baseQuery(account)
            attrs.forEach { add[$0.key] = $0.value }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw LinkError.keychain(status) }
    }

    private static func copy(_ query: [String: Any]) throws -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw LinkError.keychain(status) }
        return out as? Data
    }

    static func read(account: String) throws -> Data? {
        if let data = try copy(baseQuery(account)) { return data }
        // Ohne Gruppenangabe sucht der Schlüsselbund in allen Gruppen des
        // Programms — findet also auch Einträge von vor der geteilten Gruppe.
        guard accessGroup != nil else { return nil }
        return try copy(baseQuery(account, group: nil))
    }

    static func delete(account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
        if accessGroup != nil { SecItemDelete(baseQuery(account, group: nil) as CFDictionary) }
    }

    /// Geteilte Gruppe übernehmen (nur die App ruft das auf): prüft, ob die
    /// Signatur die Gruppe erlaubt, und zieht vorhandene Einträge um. Liefert
    /// false, wenn die Gruppe nicht nutzbar ist — dann bleibt alles in der
    /// Standardgruppe, und Erweiterungen sehen die Zugangsdaten nicht.
    @discardableResult
    public static func adoptSharedGroup(_ group: String?) -> Bool {
        guard let group, !group.isEmpty else { accessGroup = nil; return false }
        // Probe-Eintrag: ohne passendes Entitlement meldet der Schlüsselbund -34018.
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "group.probe",
            kSecAttrAccessGroup as String: group,
            kSecUseDataProtectionKeychain as String: true,
        ]
        var add = probe
        add[kSecValueData as String] = Data([1])
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        switch status {
        case errSecSuccess, errSecDuplicateItem:
            accessGroup = group
            return true
        case errSecInteractionNotAllowed:
            // Gerät gesperrt: nichts entscheiden, die Gruppe trotzdem verwenden
            // (Lesen sucht ohnehin in allen Gruppen).
            accessGroup = group
            return true
        default:
            accessGroup = nil
            return false
        }
    }

    /// Alle Einträge dieses Dienstes aus der Standardgruppe in die geteilte
    /// Gruppe umziehen. Schlägt ein Umzug fehl, bleibt der Eintrag, wo er ist
    /// (Lesen findet ihn weiter). Liefert die Zahl der umgezogenen Einträge.
    @discardableResult
    public static func migrateToSharedGroup() -> Int {
        guard let group = accessGroup else { return 0 }
        let all: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(all as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return 0 }
        var moved = 0
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  let current = item[kSecAttrAccessGroup as String] as? String, current != group else { continue }
            let status = SecItemUpdate(baseQuery(account, group: current) as CFDictionary, [kSecAttrAccessGroup as String: group] as CFDictionary)
            if status == errSecSuccess { moved += 1 }
        }
        return moved
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
