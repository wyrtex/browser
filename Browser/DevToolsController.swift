import UIKit
import WebKit
import Security

/// Owns the DevTools UI web view and bridges it with the browsed page:
/// - page agent (inject.js) → "iosDevTools" message handler → DT.onPageEvents(...) in the DevTools UI
/// - DevTools UI → "native" message handler → page commands / cookies / navigation → DT.reply(id, ...)
@MainActor
final class DevToolsController: NSObject {
    let webView: WKWebView
    private weak var page: WKWebView?
    private weak var host: BrowserViewController?
    private var ready = false
    private var pending: [String] = []
    private var documentCounter = 0

    override init() {
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.configuration.userContentController.add(WeakScriptMessageHandler(self), name: "native")
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.122, green: 0.122, blue: 0.122, alpha: 1)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        if let url = Bundle.main.url(forResource: "devtools", withExtension: "html", subdirectory: "Web") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    /// Adds the page agent and its message handler to the browsed page configuration.
    func installPageHooks(into controller: WKUserContentController) {
        if let url = Bundle.main.url(forResource: "inject", withExtension: "js", subdirectory: "Web"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        controller.add(WeakScriptMessageHandler(self), name: "iosDevTools")
    }

    func attach(page: WKWebView, host: BrowserViewController) {
        self.page = page
        self.host = host
    }

    // MARK: - Native → DevTools UI

    private func send(_ script: String) {
        guard ready else {
            pending.append(script)
            if pending.count > 3000 { pending.removeFirst(pending.count - 3000) }
            return
        }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    nonisolated private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }

    func showPanel(_ name: String) { send("DT.showPanel(\(Self.json(name)))") }
    func startInspect() { send("DT.startInspect()") }
    func setVisible(_ visible: Bool) { send("DT.onVisibility(\(visible))") }
    func sendState() { send("DT.onState(\(Self.json(state())))") }

    private func state() -> [String: Any] {
        [
            "dock": host?.dock.rawValue ?? "bottom",
            "desktop": host?.isDesktopMode ?? false,
            "visible": host?.isDevToolsVisible ?? false,
            "url": page?.url?.absoluteString ?? ""
        ]
    }

    func pageNavigationStarted(url: URL?) {
        send("DT.onNavigate(\(Self.json(["url": url?.absoluteString ?? ""])))")
    }

    func pageLoaded() {
        send("DT.onPageLoad(\(Self.json(["url": page?.url?.absoluteString ?? "", "title": page?.title ?? ""])))")
    }

    func pageLoadFailed(url: URL?, error: String) {
        send("DT.onPageError(\(Self.json(["url": url?.absoluteString ?? "", "error": error])))")
    }

    func recordDocumentResponse(_ response: WKNavigationResponse) {
        guard let http = response.response as? HTTPURLResponse else { return }
        documentCounter += 1
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields { headers["\(k)".lowercased()] = "\(v)" }
        let info: [String: Any] = [
            "id": "doc\(documentCounter)",
            "url": http.url?.absoluteString ?? "",
            "status": http.statusCode,
            "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode).capitalized,
            "headers": headers,
            "mime": http.mimeType ?? "",
            "mainFrame": response.isForMainFrame
        ]
        send("DT.onDocumentResponse(\(Self.json(info)))")
    }

    private func reply(_ id: Int, value: Any?, error: String? = nil) {
        var payload: [String: Any] = [:]
        if let error { payload["e"] = error } else { payload["v"] = value ?? NSNull() }
        if !JSONSerialization.isValidJSONObject(payload) { payload = ["e": "Result is not serializable"] }
        webView.evaluateJavaScript("DT.reply(\(id), \(Self.json(payload)))", completionHandler: nil)
    }

    nonisolated private static func message(of error: Error) -> String {
        let ns = error as NSError
        if let msg = ns.userInfo["WKJavaScriptExceptionMessage"] as? String { return msg }
        return ns.localizedDescription
    }

    // MARK: - DevTools UI → native

    private func handle(_ cmd: String, _ args: [String: Any], id: Int) {
        let done: (Any?, String?) -> Void = { [weak self] value, error in
            self?.reply(id, value: value, error: error)
        }
        switch cmd {
        case "ready":
            ready = true
            let queued = pending
            pending.removeAll()
            queued.forEach { webView.evaluateJavaScript($0, completionHandler: nil) }
            done(state(), nil)

        case "page":
            guard let page else { done(nil, "No page"); return }
            let command = args["cmd"] as? String ?? ""
            let commandArgs = args["args"] ?? [String: Any]()
            page.callAsyncJavaScript(
                "const a = window.__iosDevTools; if (!a) throw new Error('DevTools agent is not available on this page'); return await a.handle(cmd, args);",
                arguments: ["cmd": command, "args": commandArgs],
                in: nil,
                in: .page
            ) { result in
                switch result {
                case .success(let value): done(value, nil)
                case .failure(let error): done(nil, Self.message(of: error))
                }
            }

        case "evaluate":
            evaluate(args["code"] as? String ?? "", done: done)

        case "fetchSource":
            fetchSource(args["url"] as? String ?? "", done: done)

        case "getCookies":
            let host = page?.url?.host ?? ""
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                let formatter = ISO8601DateFormatter()
                let list: [[String: Any]] = cookies
                    .filter { Self.domain($0.domain, matches: host) }
                    .sorted { $0.name < $1.name }
                    .map { c in
                        [
                            "name": c.name, "value": c.value, "domain": c.domain, "path": c.path,
                            "expires": c.expiresDate.map { formatter.string(from: $0) } ?? "Session",
                            "size": c.name.utf8.count + c.value.utf8.count,
                            "httpOnly": c.isHTTPOnly, "secure": c.isSecure,
                            "sameSite": c.sameSitePolicy?.rawValue ?? ""
                        ]
                    }
                done(list, nil)
            }

        case "setCookie":
            var props: [HTTPCookiePropertyKey: Any] = [
                .name: args["name"] as? String ?? "",
                .value: args["value"] as? String ?? "",
                .domain: (args["domain"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? page?.url?.host ?? "",
                .path: (args["path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "/"
            ]
            if let days = args["days"] as? Double { props[.expires] = Date().addingTimeInterval(days * 86400) }
            if args["secure"] as? Bool == true { props[.secure] = "TRUE" }
            if args["httpOnly"] as? Bool == true { props[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            if let same = args["sameSite"] as? String, !same.isEmpty { props[.sameSitePolicy] = same }
            guard let cookie = HTTPCookie(properties: props) else { done(nil, "Invalid cookie"); return }
            WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie) { done(true, nil) }

        case "deleteCookie":
            let name = args["name"] as? String ?? ""
            let domain = args["domain"] as? String ?? ""
            let path = args["path"] as? String ?? "/"
            let store = WKWebsiteDataStore.default().httpCookieStore
            store.getAllCookies { cookies in
                let matches = cookies.filter { $0.name == name && $0.domain == domain && $0.path == path }
                guard !matches.isEmpty else { done(false, nil); return }
                let group = DispatchGroup()
                for c in matches { group.enter(); store.delete(c) { group.leave() } }
                group.notify(queue: .main) { done(true, nil) }
            }

        case "clearSiteData":
            let host = page?.url?.host ?? ""
            let store = WKWebsiteDataStore.default()
            let types = WKWebsiteDataStore.allWebsiteDataTypes()
            store.fetchDataRecords(ofTypes: types) { records in
                let matching = records.filter { Self.domain($0.displayName, matches: host) }
                store.removeData(ofTypes: types, for: matching) { done(matching.count, nil) }
            }

        case "security":
            done(securityInfo(), nil)

        case "reload":
            if args["hard"] as? Bool == true { host?.hardReload() } else { host?.reloadPage() }
            done(true, nil)

        case "navigate":
            if let s = args["url"] as? String { host?.navigate(to: s) }
            done(true, nil)

        case "close":
            host?.setDevTools(visible: false)
            done(true, nil)

        case "dock":
            if let mode = args["mode"] as? String, let dock = BrowserViewController.Dock(rawValue: mode) { host?.setDock(dock) }
            done(true, nil)

        case "setDesktop":
            host?.setDesktopMode(args["on"] as? Bool ?? false)
            done(host?.isDesktopMode ?? false, nil)

        case "theme":
            host?.setPanelDark(args["dark"] as? Bool ?? true)
            webView.backgroundColor = (args["dark"] as? Bool ?? true) ? UIColor(red: 0.122, green: 0.122, blue: 0.122, alpha: 1) : .white
            done(true, nil)

        case "copy":
            UIPasteboard.general.string = args["text"] as? String ?? ""
            done(true, nil)

        default:
            done(nil, "Unknown command: \(cmd)")
        }
    }

    nonisolated private static func domain(_ cookieDomain: String, matches host: String) -> Bool {
        guard !host.isEmpty else { return false }
        let d = cookieDomain.hasPrefix(".") ? String(cookieDomain.dropFirst()) : cookieDomain
        return host == d || host.hasSuffix("." + d)
    }

    private func securityInfo() -> [String: Any] {
        guard let page else { return [:] }
        var info: [String: Any] = [
            "url": page.url?.absoluteString ?? "",
            "secureContent": page.hasOnlySecureContent
        ]
        if let trust = page.serverTrust, let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] {
            info["certificates"] = chain.map { cert -> [String: Any] in
                ["subject": (SecCertificateCopySubjectSummary(cert) as String?) ?? "Certificate"]
            }
        }
        return info
    }

    // MARK: - Console evaluation

    /// Evaluates console input in the page's global scope. Uses native evaluation (not eval()),
    /// so it works on pages whose Content-Security-Policy forbids 'unsafe-eval'.
    private func evaluate(_ code: String, done: @escaping (Any?, String?) -> Void) {
        guard let page else { done(nil, "No page"); return }
        var expr = code.trimmingCharacters(in: .whitespacesAndNewlines)
        while expr.hasSuffix(";") { expr.removeLast(); expr = expr.trimmingCharacters(in: .whitespacesAndNewlines) }
        let agent = "window.__iosDevTools"
        let asExpression = "if (\(agent)) \(agent).installAPI();\ntry { \(agent).captureValue((\n\(expr)\n)) } catch (e) { \(agent).captureError(e) }"
        page.evaluateJavaScript(asExpression) { [weak self] result, error in
            guard let self else { return }
            if let error {
                let msg = Self.message(of: error)
                if msg.contains("SyntaxError") || msg.contains("TypeError: undefined is not an object (evaluating 'window.__iosDevTools") {
                    self.evaluateFallback(code, expr: expr, done: done)
                } else {
                    done(Self.json(["exception": true, "text": "Uncaught " + msg]), nil)
                }
                return
            }
            if let text = result as? String { done(text, nil) } else { done(Self.describe(result), nil) }
        }
    }

    private func evaluateFallback(_ code: String, expr: String, done: @escaping (Any?, String?) -> Void) {
        guard let page else { done(nil, "No page"); return }
        let agent = "window.__iosDevTools"
        if code.contains("await") {
            let asyncExpr = "const a = \(agent); a.installAPI(true); try { return a.captureValue(await (async () => (\n\(expr)\n))()); } catch (e) { return a.captureError(e); }"
            let asyncBlock = "const a = \(agent); a.installAPI(true); try { return a.captureValue(await (async () => {\n\(code)\n})()); } catch (e) { return a.captureError(e); }"
            page.callAsyncJavaScript(asyncExpr, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): done(value, nil)
                case .failure:
                    page.callAsyncJavaScript(asyncBlock, arguments: [:], in: nil, in: .page) { second in
                        switch second {
                        case .success(let value): done(value, nil)
                        case .failure(let error): done(Self.json(["exception": true, "text": "Uncaught " + Self.message(of: error)]), nil)
                        }
                    }
                }
            }
            return
        }
        page.evaluateJavaScript("if (\(agent)) \(agent).installAPI();") { _, _ in
            page.evaluateJavaScript(code) { result, error in
                if let error {
                    let ns = error as NSError
                    if ns.domain == WKErrorDomain && ns.code == WKError.Code.javaScriptResultTypeIsUnsupported.rawValue {
                        done(Self.json(["result": ["t": "undefined"]]), nil)
                    } else {
                        done(Self.json(["exception": true, "text": "Uncaught " + Self.message(of: error)]), nil)
                    }
                    return
                }
                done(Self.describe(result), nil)
            }
        }
    }

    /// Converts a value returned by native evaluation to the descriptor format used by the UI.
    nonisolated private static func describe(_ value: Any?) -> String {
        let d: [String: Any]
        switch value {
        case nil:
            d = ["t": "undefined"]
        case is NSNull:
            d = ["t": "null"]
        case let n as NSNumber where CFGetTypeID(n) == CFBooleanGetTypeID():
            d = ["t": "boolean", "v": n.boolValue ? "true" : "false"]
        case let n as NSNumber:
            d = ["t": "number", "v": n.stringValue]
        case let s as String:
            d = ["t": "string", "v": s]
        case let date as Date:
            d = ["t": "string", "v": date.description]
        case let other?:
            if JSONSerialization.isValidJSONObject(other),
               let data = try? JSONSerialization.data(withJSONObject: other, options: [.prettyPrinted, .sortedKeys]),
               let text = String(data: data, encoding: .utf8) {
                d = ["t": "json", "v": text]
            } else {
                d = ["t": "string", "v": "\(other)"]
            }
        }
        return json(["result": d])
    }

    // MARK: - Source fetching

    private func fetchSource(_ urlString: String, done: @escaping (Any?, String?) -> Void) {
        guard let url = URL(string: urlString), let scheme = url.scheme?.lowercased(), ["http", "https", "data", "file"].contains(scheme) else {
            done(nil, "Unsupported URL")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 30)
        if let ua = page?.customUserAgent, !ua.isEmpty { request.setValue(ua, forHTTPHeaderField: "User-Agent") }
        let cookieStore = WKWebsiteDataStore.default().httpCookieStore
        cookieStore.getAllCookies { cookies in
            let relevant = cookies.filter { Self.domain($0.domain, matches: url.host ?? "") }
            HTTPCookie.requestHeaderFields(with: relevant).forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
            URLSession.shared.dataTask(with: request) { data, response, error in
                var text = ""
                if let data {
                    let limited = data.count > 8_000_000 ? data.prefix(8_000_000) : data
                    text = String(data: limited, encoding: .utf8) ?? String(data: limited, encoding: .isoLatin1) ?? ""
                }
                let mime = response?.mimeType ?? ""
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                DispatchQueue.main.async {
                    if let error { done(nil, error.localizedDescription) } else { done(["text": text, "mime": mime, "status": status], nil) }
                }
            }.resume()
        }
    }
}

extension DevToolsController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "iosDevTools" {
            // Events from the page agent. Only well-formed JSON is forwarded to the DevTools UI.
            guard let body = message.body as? String, let data = body.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: data)) != nil else { return }
            send("DT.onPageEvents(\(body))")
            return
        }
        guard message.name == "native", message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let id = (body["id"] as? NSNumber)?.intValue,
              let cmd = body["cmd"] as? String else { return }
        handle(cmd, body["args"] as? [String: Any] ?? [:], id: id)
    }
}

/// Breaks the retain cycle between WKUserContentController and its message handler.
@MainActor
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
