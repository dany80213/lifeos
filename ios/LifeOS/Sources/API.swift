import Foundation

enum APIError: LocalizedError {
    case unauthorized, http(Int, String?), network(String)
    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Sessione scaduta, accedi di nuovo."
        case .http(let code, let msg): return msg ?? "Errore del server (\(code))."
        case .network(let m): return m
        }
    }
}

/// Talks to the bridge exactly like web/lifeos/jarvis-client.js: a signed session
/// cookie from POST /login, REST under /api/*, and a WebSocket at /ws for chat.
final class APIClient: NSObject, URLSessionTaskDelegate {
    static let defaultBase = ServerConfig.defaultBase
    static let baseKey = "lifeos_base_url"

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.httpCookieStorage = .shared
        cfg.httpCookieAcceptPolicy = .always
        cfg.timeoutIntervalForRequest = 30
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    var base: String {
        get { (UserDefaults.standard.string(forKey: Self.baseKey) ?? Self.defaultBase).trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) }
        set { UserDefaults.standard.set(newValue, forKey: Self.baseKey) }
    }
    private var origin: String {
        guard let u = URL(string: base), let scheme = u.scheme, let host = u.host else { return base }
        return "\(scheme)://\(host)" + (u.port.map { ":\($0)" } ?? "")
    }

    // Login answers 302 on success and 401 on bad credentials; don't follow the redirect.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func login(username: String, password: String) async throws {
        var req = URLRequest(url: URL(string: base + "/login")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        var comps = URLComponents()
        comps.queryItems = [.init(name: "username", value: username), .init(name: "password", value: password)]
        req.httpBody = comps.percentEncodedQuery?.data(using: .utf8)
        let (_, resp) = try await perform(req)
        guard let code = (resp as? HTTPURLResponse)?.statusCode else { throw APIError.network("Risposta non valida.") }
        if code == 401 { throw APIError.http(401, "Credenziali non valide.") }
        guard (200..<400).contains(code) else { throw APIError.http(code, nil) }
    }

    func logout() async {
        var req = URLRequest(url: URL(string: base + "/logout")!)
        req.httpMethod = "POST"
        _ = try? await perform(req)
        let storage = HTTPCookieStorage.shared
        storage.cookies?.filter { $0.name == "lifeos_session" }.forEach(storage.deleteCookie)
    }

    var hasSessionCookie: Bool {
        guard let u = URL(string: base) else { return false }
        return HTTPCookieStorage.shared.cookies(for: u)?.contains { $0.name == "lifeos_session" } ?? false
    }

    private func perform(_ req: URLRequest) async throws -> (Data, URLResponse) {
        do { return try await session.data(for: req) }
        catch let e as URLError where e.code == .cancelled { throw CancellationError() }
        catch { throw APIError.network("Impossibile raggiungere il server (\(error.localizedDescription)).") }
    }

    func request(_ path: String, method: String = "GET", body: JSON? = nil, query: [String: String] = [:]) async throws -> JSON {
        var comps = URLComponents(string: base + path)!
        if !query.isEmpty { comps.queryItems = query.map { .init(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, resp) = try await perform(req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 302 { throw APIError.unauthorized }
        let json = (try? JSONDecoder().decode(JSON.self, from: data)) ?? .null
        guard (200..<300).contains(code) else {
            throw APIError.http(code, json["error"].string ?? String(data: data, encoding: .utf8))
        }
        return json
    }

    // MARK: - Chat over WebSocket

    func ask(_ text: String, model: String, section: String?, onDelta: @escaping (String) -> Void) async throws -> JSON {
        let wsBase = base.replacingOccurrences(of: "https://", with: "wss://").replacingOccurrences(of: "http://", with: "ws://")
        var req = URLRequest(url: URL(string: wsBase + "/ws")!)
        req.setValue(origin, forHTTPHeaderField: "Origin")
        let task = session.webSocketTask(with: req)
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }

        let id = "ios\(Int(Date().timeIntervalSince1970 * 1000))"
        var payload: [String: JSON] = ["type": "ask", "text": .string(text), "id": .string(id), "model": .string(model)]
        if let section { payload["section"] = .string(section) }
        let out = String(data: try JSONEncoder().encode(JSON.object(payload)), encoding: .utf8)!
        try await task.send(.string(out))

        var acc = ""
        while true {
            let msg: URLSessionWebSocketTask.Message
            do { msg = try await task.receive() } catch { throw APIError.network("Connessione a Jarvis interrotta.") }
            let raw: Data
            switch msg {
            case .string(let s): raw = Data(s.utf8)
            case .data(let d): raw = d
            @unknown default: continue
            }
            guard let j = try? JSONDecoder().decode(JSON.self, from: raw), j["ask"].string == id else { continue }
            switch j["type"].str {
            case "text":
                acc += j["delta"].str
                onDelta(j["delta"].str)
            case "done":
                return .object(["text": .string(j["text"].string ?? acc), "data": j["data"], "action": j["action"]])
            case "error":
                throw APIError.network(j["message"].string ?? "Jarvis non ha risposto.")
            default: break
            }
        }
    }
}
