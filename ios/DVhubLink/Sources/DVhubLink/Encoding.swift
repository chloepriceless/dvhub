// Encoding.swift — base64url (strikt), Feldfolge mit Längenpräfix, Transkript.
// Entspricht b64u/fromB64u/framed/transcript in dvhub/services/mobile-link/crypto.js.

import Foundation
import CryptoKit

public enum LinkError: Error, Equatable, CustomStringConvertible {
    case badBase64URL
    case badLength
    case badPublicKey
    case badEphemeral
    case decryptFailed
    case fieldTooLong
    case handshake(String)
    case boxSignatureInvalid
    case notAPairingCode
    case versionUnsupported
    case closed(code: Int, reason: String)
    case timeout
    case protocolError(String)
    case relay(String)
    case noRoute
    case boxOffline
    case pairingDenied
    case keychain(Int32)

    public var description: String {
        switch self {
        case .badBase64URL: return L("Ungültige Kodierung")
        case .badLength: return L("Falsche Länge")
        case .badPublicKey: return L("Ungültiger Schlüssel")
        case .badEphemeral: return L("Ungültiger Sitzungsschlüssel")
        case .decryptFailed: return L("Entschlüsselung fehlgeschlagen")
        case .fieldTooLong: return L("Feld zu lang")
        case .handshake(let s): return L("Handshake: \(s)")
        case .boxSignatureInvalid: return L("Die Box hat sich nicht korrekt ausgewiesen")
        case .notAPairingCode: return L("Kein DVhub-Kopplungscode")
        case .versionUnsupported: return L("Protokollversion wird nicht unterstützt")
        case .closed(let code, let reason): return reason.isEmpty ? L("Verbindung geschlossen (\(String(code)))") : L("Verbindung geschlossen: \(reason) (\(String(code)))")
        case .timeout: return L("Zeitüberschreitung")
        case .protocolError(let s): return L("Protokollfehler: \(s)")
        case .relay(let s): return L("Relay: \(s)")
        case .noRoute: return L("Kein Weg zur Anlage")
        case .boxOffline: return L("Anlage nicht verbunden")
        case .pairingDenied: return L("Kopplung abgelehnt")
        case .keychain(let s): return L("Schlüsselbund-Fehler \(String(s))")
        }
    }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strikt: nur das base64url-Alphabet, keine Füllzeichen, kanonische Form.
    public static func decode(_ string: String, length: Int? = nil) throws -> Data {
        let allowed = string.utf8.allSatisfy { c in
            (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
        }
        guard allowed, string.utf8.count % 4 != 1 else { throw LinkError.badBase64URL }
        var b64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let pad = (4 - b64.utf8.count % 4) % 4
        b64 += String(repeating: "=", count: pad)
        guard let data = Data(base64Encoded: b64), encode(data) == string else { throw LinkError.badBase64URL }
        if let length, data.count != length { throw LinkError.badLength }
        return data
    }
}

/// Ein Feld im Transkript: Bytes, Text (UTF-8) oder ganze Zahl (Dezimaltext).
public enum Field {
    case bytes(Data)
    case text(String)
    case int(Int64)

    var bytes: Data {
        switch self {
        case .bytes(let d): return d
        case .text(let s): return Data(s.utf8)
        case .int(let n): return Data(String(n).utf8)
        }
    }
}

public func framed(_ parts: [Field]) throws -> Data {
    var out = Data()
    for part in parts {
        let b = part.bytes
        guard b.count <= 0xFFFF else { throw LinkError.fieldTooLong }
        out.append(UInt8(b.count >> 8))
        out.append(UInt8(b.count & 0xFF))
        out.append(b)
    }
    return out
}

public func transcript(_ parts: [Field]) throws -> Data {
    Data(SHA256.hash(data: try framed(parts)))
}

public func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// Text aus dem String-Katalog dieses Pakets (Ausgangssprache Deutsch).
func L(_ key: String.LocalizationValue) -> String { String(localized: key, bundle: .module) }
