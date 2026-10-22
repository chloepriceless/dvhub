// Identity.swift — Geräteschlüssel (P-256) und Signaturprüfung.
//
// Auf echten Geräten liegt der Schlüssel in der Secure Enclave: Er kann das
// iPhone nie verlassen und ist nur bei entsperrtem Gerät nutzbar. Im Simulator
// (keine Secure Enclave) gibt es einen Software-Schlüssel im Schlüsselbund.

import Foundation
import CryptoKit
import Security

public protocol LinkSigner {
    /// Öffentlicher Schlüssel, unkomprimiert (65 Byte, 0x04‖X‖Y).
    var publicRaw: Data { get }
    /// ECDSA P-256 über SHA-256(data), roh r‖s (64 Byte).
    func sign(_ data: Data) throws -> Data
}

public extension LinkSigner {
    var id: String { keyId(publicRaw) }
}

/// Kurz-ID: erste 16 Byte von SHA-256(Schlüssel), base64url.
public func keyId(_ publicRaw: Data) -> String {
    Base64URL.encode(sha256(publicRaw).prefix(16))
}

public func verifySignature(publicRaw: Data, data: Data, signature: Data) -> Bool {
    guard publicRaw.count == 65, publicRaw.first == 0x04, signature.count == 64,
          let key = try? P256.Signing.PublicKey(x963Representation: publicRaw),
          let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
    return key.isValidSignature(sig, for: data)
}

public struct SoftwareSigner: LinkSigner {
    let key: P256.Signing.PrivateKey

    public init() { key = P256.Signing.PrivateKey() }
    public init(rawScalar: Data) throws { key = try P256.Signing.PrivateKey(rawRepresentation: rawScalar) }

    public var publicRaw: Data { key.publicKey.x963Representation }
    public var rawScalar: Data { key.rawRepresentation }
    public func sign(_ data: Data) throws -> Data { try key.signature(for: data).rawRepresentation }
}

public struct SecureEnclaveSigner: LinkSigner {
    let key: SecureEnclave.P256.Signing.PrivateKey

    public static var isAvailable: Bool { SecureEnclave.isAvailable }

    /// Neuer Schlüssel in der Secure Enclave (nur bei entsperrtem Gerät, nicht übertragbar).
    public init() throws {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, &error
        ) else {
            throw LinkError.keychain(-1)
        }
        key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    }

    /// Aus der verschlüsselten Darstellung (nur auf diesem Gerät gültig).
    public init(dataRepresentation: Data) throws {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation)
    }

    public var dataRepresentation: Data { key.dataRepresentation }
    public var publicRaw: Data { key.publicKey.x963Representation }
    public func sign(_ data: Data) throws -> Data { try key.signature(for: data).rawRepresentation }
}
