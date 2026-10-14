import UIKit
import WebKit

final class BrowserViewController: UIViewController {
    enum Dock: String { case bottom, right, full }

    static let homeURL = URL(string: "https://www.google.com/")!
    static let desktopUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

    var initialURL: URL?

    private(set) var webView: WKWebView!
    private var devTools: DevToolsController!

    private let toolbar = UIStackView()
    private let backButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private let reloadButton = UIButton(type: .system)
    private let devToolsButton = UIButton(type: .system)
    private let menuButton = UIButton(type: .system)
    private let addressField = UITextField()
    private let progressView = UIProgressView(progressViewStyle: .bar)
    private let contentStack = UIStackView()
    private let panel = DevToolsPanelView()
    private let errorView = PageErrorView()

    private var panelHeight: NSLayoutConstraint!
    private var panelWidth: NSLayoutConstraint!
    private var panelFraction: CGFloat = 0.45
    private var dragStartSize: CGFloat = 0
    private(set) var dock: Dock = .bottom
    private(set) var isDesktopMode = false
    private var failedURL: URL?
    private var observations: [NSKeyValueObservation] = []

    var isDevToolsVisible: Bool { !panel.isHidden }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        if let saved = UserDefaults.standard.string(forKey: "dock"), let d = Dock(rawValue: saved) { dock = d }
        let fraction = UserDefaults.standard.double(forKey: "panelFraction")
        if fraction > 0.1 && fraction < 0.95 { panelFraction = CGFloat(fraction) }
        isDesktopMode = UserDefaults.standard.bool(forKey: "desktopMode")

        devTools = DevToolsController()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.websiteDataStore = .default()
        devTools.installPageHooks(into: config.userContentController)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = true
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        if #available(iOS 16.0, *) { webView.isFindInteractionEnabled = true }
        if isDesktopMode { webView.customUserAgent = Self.desktopUserAgent }

        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        devTools.attach(page: webView, host: self)

        setupToolbar()
        setupLayout()
        observeWebView()
        updateButtons()
        applyDock()

        load(initialURL ?? Self.homeURL)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    override var canBecomeFirstResponder: Bool { true }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updatePanelSize()
    }

    // MARK: - UI setup

    private func symbol(_ name: String, size: CGFloat = 17) -> UIImage? {
        UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .medium))
    }

    private func configure(_ button: UIButton, _ symbolName: String, _ action: Selector, _ label: String) {
        button.setImage(symbol(symbolName), for: .normal)
        button.addTarget(self, action: action, for: .touchUpInside)
        button.accessibilityLabel = label
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 34).isActive = true
        button.heightAnchor.constraint(equalToConstant: 40).isActive = true
    }

    private func setupToolbar() {
        configure(backButton, "chevron.backward", #selector(goBack), "Назад")
        configure(forwardButton, "chevron.forward", #selector(goForward), "Вперёд")
        configure(reloadButton, "arrow.clockwise", #selector(reloadOrStop), "Обновить")
        configure(devToolsButton, "chevron.left.forwardslash.chevron.right", #selector(toggleDevTools), "Инструменты разработчика")
        configure(menuButton, "ellipsis.circle", #selector(noop), "Меню")
        menuButton.showsMenuAsPrimaryAction = true
        menuButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.menuElements() ?? [])
        }])

        addressField.borderStyle = .none
        addressField.backgroundColor = .secondarySystemBackground
        addressField.layer.cornerRadius = 10
        addressField.font = .systemFont(ofSize: 15)
        addressField.placeholder = "Поиск в Google или введите URL"
        addressField.keyboardType = .webSearch
        addressField.returnKeyType = .go
        addressField.autocapitalizationType = .none
        addressField.autocorrectionType = .no
        addressField.spellCheckingType = .no
        addressField.textContentType = .URL
        addressField.clearButtonMode = .whileEditing
        addressField.delegate = self
        let icon = UIImageView(image: symbol("magnifyingglass", size: 13))
        icon.tintColor = .secondaryLabel
        icon.contentMode = .center
        icon.frame = CGRect(x: 0, y: 0, width: 30, height: 36)
        addressField.leftView = icon
        addressField.leftViewMode = .always
        addressField.translatesAutoresizingMaskIntoConstraints = false
        addressField.heightAnchor.constraint(equalToConstant: 36).isActive = true
        addressField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        toolbar.axis = .horizontal
        toolbar.alignment = .center
        toolbar.spacing = 2
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        [backButton, forwardButton, reloadButton, addressField, devToolsButton, menuButton].forEach(toolbar.addArrangedSubview)
        toolbar.setCustomSpacing(6, after: reloadButton)
        toolbar.setCustomSpacing(6, after: addressField)
    }

    private func setupLayout() {
        let topBar = UIView()
        topBar.backgroundColor = .systemBackground
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)
        topBar.addSubview(toolbar)

        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.progressTintColor = .systemBlue
        progressView.trackTintColor = .clear
        view.addSubview(progressView)

        let separator = UIView()
        separator.backgroundColor = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(separator)

        contentStack.axis = .vertical
        contentStack.distribution = .fill
        contentStack.alignment = .fill
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(contentStack)

        let pageContainer = UIView()
        pageContainer.translatesAutoresizingMaskIntoConstraints = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        pageContainer.addSubview(webView)
        errorView.translatesAutoresizingMaskIntoConstraints = false
        errorView.isHidden = true
        errorView.retry = { [weak self] in self?.reloadPage() }
        pageContainer.addSubview(errorView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: pageContainer.topAnchor),
            webView.bottomAnchor.constraint(equalTo: pageContainer.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: pageContainer.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: pageContainer.trailingAnchor),
            errorView.topAnchor.constraint(equalTo: pageContainer.topAnchor),
            errorView.bottomAnchor.constraint(equalTo: pageContainer.bottomAnchor),
            errorView.leadingAnchor.constraint(equalTo: pageContainer.leadingAnchor),
            errorView.trailingAnchor.constraint(equalTo: pageContainer.trailingAnchor)
        ])
        pageContainerView = pageContainer

        panel.translatesAutoresizingMaskIntoConstraints = false
        panel.install(devTools.webView)
        panel.isHidden = true
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePanelDrag(_:)))
        panel.handle.addGestureRecognizer(pan)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(togglePanelMaximized))
        doubleTap.numberOfTapsRequired = 2
        panel.handle.addGestureRecognizer(doubleTap)

        contentStack.addArrangedSubview(pageContainer)
        contentStack.addArrangedSubview(panel)

        panelHeight = panel.heightAnchor.constraint(equalToConstant: 300)
        panelHeight.priority = UILayoutPriority(999)
        panelWidth = panel.widthAnchor.constraint(equalToConstant: 360)
        panelWidth.priority = UILayoutPriority(999)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            toolbar.topAnchor.constraint(equalTo: guide.topAnchor, constant: 2),
            toolbar.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 6),
            toolbar.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -6),
            toolbar.heightAnchor.constraint(equalToConstant: 44),
            topBar.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: 2),

            separator.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            separator.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            separator.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),

            progressView.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            progressView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progressView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 2.5),

            contentStack.topAnchor.constraint(equalTo: separator.bottomAnchor),
            contentStack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentStack.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        view.bringSubviewToFront(progressView)
    }

    private var pageContainerView: UIView!

    private func observeWebView() {
        observations = [
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in self?.updateProgress() },
            webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.updateButtons(); self?.updateProgress() },
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in self?.updateAddress() },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.updateButtons() },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.updateButtons() },
            webView.observe(\.hasOnlySecureContent, options: [.new]) { [weak self] _, _ in self?.updateAddress() }
        ]
    }

    // MARK: - State updates

    private func updateProgress() {
        let p = Float(webView.estimatedProgress)
        if webView.isLoading && p < 1 {
            progressView.alpha = 1
            progressView.setProgress(max(p, 0.05), animated: true)
        } else {
            progressView.setProgress(1, animated: true)
            UIView.animate(withDuration: 0.25, delay: 0.15, options: [], animations: { self.progressView.alpha = 0 }) { _ in
                if !self.webView.isLoading { self.progressView.setProgress(0, animated: false) }
            }
        }
    }

    private func updateButtons() {
        backButton.isEnabled = webView.canGoBack
        forwardButton.isEnabled = webView.canGoForward
        reloadButton.setImage(symbol(webView.isLoading ? "xmark" : "arrow.clockwise"), for: .normal)
        devToolsButton.tintColor = isDevToolsVisible ? .systemBlue : .label
    }

    private func updateAddress() {
        guard !addressField.isEditing else { return }
        let url = failedURL ?? webView.url
        addressField.text = displayText(for: url)
        let secure = url?.scheme == "https"
        let icon = addressField.leftView as? UIImageView
        if url == nil {
            icon?.image = symbol("magnifyingglass", size: 13)
            icon?.tintColor = .secondaryLabel
        } else {
            icon?.image = symbol(secure ? "lock.fill" : "exclamationmark.triangle", size: 12)
            icon?.tintColor = secure ? .secondaryLabel : .systemOrange
        }
    }

    private func displayText(for url: URL?) -> String {
        guard let url else { return "" }
        if url.host?.hasSuffix("google.com") == true, url.path == "/search",
           let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "q" })?.value {
            return q
        }
        return url.absoluteString
    }

    // MARK: - Navigation

    func load(_ url: URL) {
        failedURL = nil
        errorView.isHidden = true
        webView.load(URLRequest(url: url))
    }

    func navigate(to input: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        load(Self.url(fromInput: text))
    }

    static func url(fromInput text: String) -> URL {
        let lower = text.lowercased()
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(),
           ["http", "https", "file", "about", "data"].contains(scheme),
           url.host != nil || scheme == "about" || scheme == "data" {
            return url
        }
        if !text.contains(" ") {
            let isLocal = lower.hasPrefix("localhost") || lower.range(of: #"^\d{1,3}(\.\d{1,3}){3}(:\d+)?(/.*)?$"#, options: .regularExpression) != nil
            if isLocal, let url = URL(string: "http://" + text) { return url }
            if text.contains("."), !text.hasSuffix("."),
               let url = URL(string: "https://" + text), let host = url.host, host.contains(".") {
                return url
            }
        }
        var comps = URLComponents(string: "https://www.google.com/search")!
        comps.queryItems = [URLQueryItem(name: "q", value: text)]
        return comps.url!
    }

    @objc func goBack() { if webView.canGoBack { webView.goBack() } }
    @objc func goForward() { if webView.canGoForward { webView.goForward() } }
    @objc func goHome() { load(Self.homeURL) }
    @objc private func noop() {}

    @objc func reloadOrStop() {
        if webView.isLoading { webView.stopLoading() } else { reloadPage() }
    }

    /// F5 — reloads only the page. The app, the address bar and the DevTools panel stay as they are.
    @objc func reloadPage() {
        if let failed = failedURL { load(failed); return }
        if webView.url == nil { load(initialURL ?? Self.homeURL); return }
        webView.reload()
    }

    /// Shift+F5 / Ctrl+F5 / ⌘⇧R — reload bypassing the cache.
    @objc func hardReload() {
        if let failed = failedURL { load(failed); return }
        if webView.url == nil { load(Self.homeURL); return }
        webView.reloadFromOrigin()
    }

    @objc private func pullToRefresh(_ sender: UIRefreshControl) {
        reloadPage()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { sender.endRefreshing() }
    }

    @objc func focusAddressBar() {
        addressField.becomeFirstResponder()
    }

    func setDesktopMode(_ on: Bool) {
        guard on != isDesktopMode else { return }
        isDesktopMode = on
        UserDefaults.standard.set(on, forKey: "desktopMode")
        webView.customUserAgent = on ? Self.desktopUserAgent : nil
        reloadPage()
    }

    // MARK: - DevTools panel

    @objc func toggleDevTools() {
        setDevTools(visible: !isDevToolsVisible)
    }

    @objc func openConsole() {
        devTools.showPanel("console")
        setDevTools(visible: true)
    }

    @objc func inspectElement() {
        setDevTools(visible: true)
        devTools.showPanel("elements")
        devTools.startInspect()
    }

    func setDevTools(visible: Bool) {
        guard visible != isDevToolsVisible else { return }
        view.endEditing(true)
        panel.isHidden = !visible
        pageContainerView.isHidden = visible && dock == .full
        updatePanelSize()
        devTools.setVisible(visible)
        updateButtons()
        if !visible { becomeFirstResponder() }
    }

    func setPanelDark(_ dark: Bool) {
        panel.setDark(dark)
    }

    func setDock(_ newDock: Dock) {
        dock = newDock
        UserDefaults.standard.set(newDock.rawValue, forKey: "dock")
        applyDock()
        devTools.sendState()
    }

    private func applyDock() {
        contentStack.axis = dock == .right ? .horizontal : .vertical
        panel.dock = dock
        pageContainerView.isHidden = dock == .full && isDevToolsVisible
        panelHeight.isActive = dock == .bottom
        panelWidth.isActive = dock == .right
        updatePanelSize()
    }

    private func updatePanelSize() {
        guard panelHeight != nil else { return }
        let total = dock == .right ? contentStack.bounds.width : contentStack.bounds.height
        guard total > 0 else { return }
        let size = min(max(total * panelFraction, 140), max(140, total - 80))
        if dock == .bottom, abs(panelHeight.constant - size) > 0.5 { panelHeight.constant = size }
        if dock == .right, abs(panelWidth.constant - size) > 0.5 { panelWidth.constant = size }
    }

    @objc private func handlePanelDrag(_ g: UIPanGestureRecognizer) {
        guard dock != .full else { return }
        let total = dock == .right ? contentStack.bounds.width : contentStack.bounds.height
        guard total > 0 else { return }
        switch g.state {
        case .began:
            dragStartSize = dock == .right ? panel.bounds.width : panel.bounds.height
        case .changed:
            let t = g.translation(in: contentStack)
            let delta = dock == .right ? -t.x : -t.y
            let size = min(max(dragStartSize + delta, 140), total - 60)
            panelFraction = size / total
            updatePanelSize()
        case .ended, .cancelled:
            UserDefaults.standard.set(Double(panelFraction), forKey: "panelFraction")
        default:
            break
        }
    }

    @objc private func togglePanelMaximized() {
        panelFraction = panelFraction > 0.75 ? 0.45 : 0.85
        UIView.animate(withDuration: 0.2) {
            self.updatePanelSize()
            self.view.layoutIfNeeded()
        }
        UserDefaults.standard.set(Double(panelFraction), forKey: "panelFraction")
    }

    // MARK: - Menu

    private func menuElements() -> [UIMenuElement] {
        let devtools = UIAction(title: isDevToolsVisible ? "Закрыть DevTools (F12)" : "Инструменты разработчика (F12)",
                                image: symbol("chevron.left.forwardslash.chevron.right")) { [weak self] _ in self?.toggleDevTools() }
        let console = UIAction(title: "Консоль", image: symbol("terminal")) { [weak self] _ in self?.openConsole() }
        let inspect = UIAction(title: "Проверить элемент", image: symbol("cursorarrow.rays")) { [weak self] _ in self?.inspectElement() }
        let dockMenu = UIMenu(title: "Положение панели", image: symbol("rectangle.split.2x1"), children: [
            UIAction(title: "Снизу", state: dock == .bottom ? .on : .off) { [weak self] _ in self?.setDock(.bottom) },
            UIAction(title: "Справа", state: dock == .right ? .on : .off) { [weak self] _ in self?.setDock(.right) },
            UIAction(title: "На весь экран", state: dock == .full ? .on : .off) { [weak self] _ in self?.setDock(.full) }
        ])
        let devGroup = UIMenu(title: "", options: .displayInline, children: [devtools, console, inspect, dockMenu])

        let reload = UIAction(title: "Обновить (F5)", image: symbol("arrow.clockwise")) { [weak self] _ in self?.reloadPage() }
        let hard = UIAction(title: "Обновить без кэша (⇧F5)", image: symbol("arrow.triangle.2.circlepath")) { [weak self] _ in self?.hardReload() }
        let home = UIAction(title: "Google", image: symbol("house")) { [weak self] _ in self?.goHome() }
        let desktop = UIAction(title: "Версия для ПК", image: symbol("desktopcomputer"), state: isDesktopMode ? .on : .off) { [weak self] _ in
            guard let self else { return }
            self.setDesktopMode(!self.isDesktopMode)
            self.devTools.sendState()
        }
        var pageItems: [UIMenuElement] = [reload, hard, home, desktop]
        if #available(iOS 16.0, *) {
            pageItems.append(UIAction(title: "Найти на странице", image: symbol("doc.text.magnifyingglass")) { [weak self] _ in
                self?.webView.findInteraction?.presentFindNavigator(showingReplace: false)
            })
        }
        pageItems.append(UIAction(title: "Поделиться", image: symbol("square.and.arrow.up")) { [weak self] _ in self?.share() })
        let pageGroup = UIMenu(title: "", options: .displayInline, children: pageItems)

        let clear = UIAction(title: "Очистить данные сайтов", image: symbol("trash"), attributes: .destructive) { [weak self] _ in
            self?.confirmClearData()
        }
        return [devGroup, pageGroup, UIMenu(title: "", options: .displayInline, children: [clear])]
    }

    private func share() {
        guard let url = webView.url else { return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = menuButton
        vc.popoverPresentationController?.sourceRect = menuButton.bounds
        present(vc, animated: true)
    }

    private func confirmClearData() {
        let alert = UIAlertController(title: "Очистить данные?", message: "Будут удалены cookies, кэш и хранилища всех сайтов.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel))
        alert.addAction(UIAlertAction(title: "Очистить", style: .destructive) { [weak self] _ in
            WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                self?.reloadPage()
            }
        })
        present(alert, animated: true)
    }

    // MARK: - Hardware keyboard (F5, F12, ...)

    private func key(_ input: String, _ flags: UIKeyModifierFlags, _ action: Selector, _ title: String) -> UIKeyCommand {
        let cmd = UIKeyCommand(title: title, action: action, input: input, modifierFlags: flags)
        cmd.wantsPriorityOverSystemBehavior = true
        return cmd
    }

    override var keyCommands: [UIKeyCommand]? {
        [
            key(UIKeyCommand.f5, [], #selector(reloadPage), "Обновить страницу"),
            key(UIKeyCommand.f5, .shift, #selector(hardReload), "Обновить без кэша"),
            key(UIKeyCommand.f5, .control, #selector(hardReload), "Обновить без кэша"),
            key("r", .command, #selector(reloadPage), "Обновить страницу"),
            key("r", [.command, .shift], #selector(hardReload), "Обновить без кэша"),
            key(UIKeyCommand.f12, [], #selector(toggleDevTools), "Инструменты разработчика"),
            key("i", [.command, .alternate], #selector(toggleDevTools), "Инструменты разработчика"),
            key("i", [.control, .shift], #selector(toggleDevTools), "Инструменты разработчика"),
            key("j", [.command, .alternate], #selector(openConsole), "Консоль"),
            key("j", [.control, .shift], #selector(openConsole), "Консоль"),
            key("c", [.command, .shift], #selector(inspectElement), "Проверить элемент"),
            key("l", .command, #selector(focusAddressBar), "Адресная строка"),
            key("[", .command, #selector(goBack), "Назад"),
            key("]", .command, #selector(goForward), "Вперёд"),
            key(UIKeyCommand.inputLeftArrow, .command, #selector(goBack), "Назад"),
            key(UIKeyCommand.inputRightArrow, .command, #selector(goForward), "Вперёд")
        ]
    }

    // MARK: - Alerts

    fileprivate func presentSafely(_ vc: UIViewController, fallback: () -> Void) {
        guard presentedViewController == nil, viewIfLoaded?.window != nil else { fallback(); return }
        present(vc, animated: true)
    }
}

// MARK: - UITextFieldDelegate

extension BrowserViewController: UITextFieldDelegate {
    func textFieldDidBeginEditing(_ textField: UITextField) {
        textField.text = (failedURL ?? webView.url)?.absoluteString ?? textField.text
        DispatchQueue.main.async { textField.selectAll(nil) }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        let text = textField.text ?? ""
        textField.resignFirstResponder()
        navigate(to: text)
        return true
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        updateAddress()
    }
}

// MARK: - WKNavigationDelegate

extension BrowserViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.preferredContentMode = isDesktopMode ? .desktop : .mobile
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(),
           !["http", "https", "about", "file", "data", "blob", "javascript"].contains(scheme) {
            UIApplication.shared.open(url)
            decisionHandler(.cancel, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        devTools.recordDocumentResponse(navigationResponse)
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        devTools.pageNavigationStarted(url: webView.url)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        failedURL = nil
        errorView.isHidden = true
        updateAddress()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        devTools.pageLoaded()
        updateAddress()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func handleLoadError(_ error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let ns = error as NSError
        // Cancelled (e.g. a new navigation started) or "frame load interrupted" (downloads) are not real failures.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && (ns.code == 102 || ns.code == 204) { return }
        let failing = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL)
            ?? (ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String).flatMap(URL.init(string:))
        devTools.pageLoadFailed(url: failing, error: ns.localizedDescription)
        failedURL = failing
        errorView.show(host: failing?.host ?? failing?.absoluteString ?? "", message: ns.localizedDescription)
        updateAddress()
    }
}

// MARK: - WKUIDelegate

extension BrowserViewController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == false {
            webView.load(navigationAction.request)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentSafely(alert, fallback: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentSafely(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: frame.request.url?.host, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        presentSafely(alert) { completionHandler(nil) }
    }
}

// MARK: - Panel container

final class DevToolsPanelView: UIView {
    let handle = UIView()
    private let grip = UIView()
    private var content: UIView?
    private var bottomConstraints: [NSLayoutConstraint] = []
    private var rightConstraints: [NSLayoutConstraint] = []
    private var fullConstraints: [NSLayoutConstraint] = []

    var dock: BrowserViewController.Dock = .bottom { didSet { applyDock() } }

    func setDark(_ dark: Bool) {
        let bg = dark ? UIColor(red: 0.157, green: 0.157, blue: 0.157, alpha: 1) : UIColor(red: 0.945, green: 0.953, blue: 0.957, alpha: 1)
        handle.backgroundColor = bg
        backgroundColor = dark ? UIColor(red: 0.122, green: 0.122, blue: 0.122, alpha: 1) : .white
        grip.backgroundColor = dark ? UIColor(white: 0.45, alpha: 1) : UIColor(white: 0.6, alpha: 1)
    }

    func install(_ webView: UIView) {
        content = webView
        handle.translatesAutoresizingMaskIntoConstraints = false
        grip.translatesAutoresizingMaskIntoConstraints = false
        grip.layer.cornerRadius = 2
        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)
        addSubview(handle)
        handle.addSubview(grip)
        setDark(traitCollection.userInterfaceStyle != .light)

        let topLine = UIView()
        topLine.backgroundColor = .separator
        topLine.translatesAutoresizingMaskIntoConstraints = false
        handle.addSubview(topLine)

        NSLayoutConstraint.activate([
            grip.centerXAnchor.constraint(equalTo: handle.centerXAnchor),
            grip.centerYAnchor.constraint(equalTo: handle.centerYAnchor),
            topLine.leadingAnchor.constraint(equalTo: handle.leadingAnchor),
            topLine.topAnchor.constraint(equalTo: handle.topAnchor)
        ])
        let lineH = topLine.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale)
        let lineW = topLine.widthAnchor.constraint(equalTo: handle.widthAnchor)
        let lineV = topLine.widthAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale)
        let lineVH = topLine.heightAnchor.constraint(equalTo: handle.heightAnchor)

        bottomConstraints = [
            handle.topAnchor.constraint(equalTo: topAnchor),
            handle.leadingAnchor.constraint(equalTo: leadingAnchor),
            handle.trailingAnchor.constraint(equalTo: trailingAnchor),
            handle.heightAnchor.constraint(equalToConstant: 16),
            grip.widthAnchor.constraint(equalToConstant: 40),
            grip.heightAnchor.constraint(equalToConstant: 4),
            webView.topAnchor.constraint(equalTo: handle.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            lineH, lineW
        ]
        rightConstraints = [
            handle.topAnchor.constraint(equalTo: topAnchor),
            handle.bottomAnchor.constraint(equalTo: bottomAnchor),
            handle.leadingAnchor.constraint(equalTo: leadingAnchor),
            handle.widthAnchor.constraint(equalToConstant: 16),
            grip.widthAnchor.constraint(equalToConstant: 4),
            grip.heightAnchor.constraint(equalToConstant: 40),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.leadingAnchor.constraint(equalTo: handle.trailingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            lineV, lineVH
        ]
        fullConstraints = [
            handle.topAnchor.constraint(equalTo: topAnchor),
            handle.leadingAnchor.constraint(equalTo: leadingAnchor),
            handle.widthAnchor.constraint(equalToConstant: 0),
            handle.heightAnchor.constraint(equalToConstant: 0),
            grip.widthAnchor.constraint(equalToConstant: 0),
            grip.heightAnchor.constraint(equalToConstant: 0),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            lineH, lineW
        ]
        applyDock()
    }

    private func applyDock() {
        guard content != nil else { return }
        NSLayoutConstraint.deactivate(bottomConstraints + rightConstraints + fullConstraints)
        switch dock {
        case .bottom: NSLayoutConstraint.activate(bottomConstraints)
        case .right: NSLayoutConstraint.activate(rightConstraints)
        case .full: NSLayoutConstraint.activate(fullConstraints)
        }
        handle.isHidden = dock == .full
    }
}

// MARK: - Error page

final class PageErrorView: UIView {
    var retry: (() -> Void)?
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        let icon = UIImageView(image: UIImage(systemName: "wifi.exclamationmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 44)))
        icon.tintColor = .secondaryLabel
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.numberOfLines = 0
        titleLabel.textAlignment = .center
        messageLabel.font = .systemFont(ofSize: 15)
        messageLabel.textColor = .secondaryLabel
        messageLabel.numberOfLines = 0
        messageLabel.textAlignment = .center
        let button = UIButton(type: .system)
        button.setTitle("Обновить", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        button.addTarget(self, action: #selector(tapRetry), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [icon, titleLabel, messageLabel, button])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -40),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -32)
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(host: String, message: String) {
        titleLabel.text = host.isEmpty ? "Не удаётся открыть страницу" : "Не удаётся получить доступ к сайту \(host)"
        messageLabel.text = message
        isHidden = false
    }

    @objc private func tapRetry() { retry?() }
}
