import Foundation

/// Schemaless JSON: the bridge's /api/lifeos-data shape evolves with the web pages,
/// so the app reads it through forgiving accessors instead of rigid Codable models.
enum JSON: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else if let v = try? c.decode([String: JSON].self) { self = .object(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    subscript(key: String) -> JSON {
        if case .object(let o) = self { return o[key] ?? .null }
        return .null
    }
    subscript(index: Int) -> JSON {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return .null
    }

    var array: [JSON] { if case .array(let a) = self { return a }; return [] }
    var dict: [String: JSON] { if case .object(let o) = self { return o }; return [:] }
    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        default: return nil
        }
    }
    var str: String { string ?? "" }
    var double: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }
    var num: Double { double ?? 0 }
    var int: Int { Int(num) }
    var bool: Bool {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        default: return false
        }
    }
    var isNull: Bool { if case .null = self { return true }; return false }
    var strings: [String] { array.compactMap { $0.string } }
    var ints: [Int] { array.map { $0.int } }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
                ExpressibleByBooleanLiteral, ExpressibleByNilLiteral, ExpressibleByArrayLiteral,
                ExpressibleByDictionaryLiteral {
    init(stringLiteral v: String) { self = .string(v) }
    init(integerLiteral v: Int) { self = .number(Double(v)) }
    init(floatLiteral v: Double) { self = .number(v) }
    init(booleanLiteral v: Bool) { self = .bool(v) }
    init(nilLiteral: ()) { self = .null }
    init(arrayLiteral elements: JSON...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSON)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}
