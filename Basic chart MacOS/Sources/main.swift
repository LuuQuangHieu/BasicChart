// Basic chart for macOS: one window with a WKWebView showing the BasicChart web app, which is packed into
// the app bundle (Contents/Resources/web).
//
// Pages are served from the custom scheme basicchart://app/ so the web app gets its own origin
// (localStorage, fetch). Data sources that refuse browser requests are fetched here instead, the way the
// Vite dev server proxies them on a computer:
//   /yahoo/…    → query1.finance.yahoo.com     /cmc/…      → api.coinmarketcap.com
//   /fred/…     → fred.stlouisfed.org          /entrade/…  → services.entrade.com.vn
// Everything else (crypto exchanges, websockets) goes straight to the network from the page.
import AppKit
import UniformTypeIdentifiers
import WebKit

let scheme = "basicchart"
let startURL = URL(string: "\(scheme)://app/index.html")!
let proxies: [(prefix: String, target: String)] = [
  ("/yahoo/", "https://query1.finance.yahoo.com/"),
  ("/cmc/", "https://api.coinmarketcap.com/"),
  ("/fred/", "https://fred.stlouisfed.org/"),
  ("/entrade/", "https://services.entrade.com.vn/"),
]
let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

/// Serves the bundled web files and proxies the data sources for basicchart:// requests.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
  private let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web")
  private let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 30
    c.httpAdditionalHeaders = ["User-Agent": userAgent]
    return URLSession(configuration: c)
  }()
  /// running proxy fetches, so a request the page cancels is never answered
  private var running: [ObjectIdentifier: URLSessionDataTask] = [:]
  private let lock = NSLock()

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let path = url.path.isEmpty ? "/" : url.path
    if let p = proxies.first(where: { path.hasPrefix($0.prefix) }) {
      var target = p.target + String(path.dropFirst(p.prefix.count))
      if let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery { target += "?" + q }
      proxy(URL(string: target)!, for: task)
    } else {
      serveFile(path == "/" ? "/index.html" : path, for: task)
    }
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    lock.lock()
    let t = running.removeValue(forKey: ObjectIdentifier(task))
    lock.unlock()
    t?.cancel()
  }

  private func serveFile(_ path: String, for task: WKURLSchemeTask) {
    let file = webRoot.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard file.path.hasPrefix(webRoot.path), let data = try? Data(contentsOf: file) else {
      respond(task, status: 404, headers: ["Content-Type": "text/plain"], body: Data("Not found".utf8))
      return
    }
    let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    respond(task, status: 200, headers: ["Content-Type": mime, "Cache-Control": "no-cache"], body: data)
  }

  private func proxy(_ target: URL, for task: WKURLSchemeTask) {
    var req = URLRequest(url: target)
    if let accept = task.request.value(forHTTPHeaderField: "Accept") { req.setValue(accept, forHTTPHeaderField: "Accept") }
    let id = ObjectIdentifier(task)
    let dataTask = session.dataTask(with: req) { [weak self] data, response, error in
      guard let self else { return }
      self.lock.lock()
      let stillWanted = self.running.removeValue(forKey: id) != nil
      self.lock.unlock()
      guard stillWanted else { return }
      DispatchQueue.main.async {
        guard let http = response as? HTTPURLResponse else {
          self.respond(task, status: 502, headers: ["Content-Type": "text/plain"],
                       body: Data("Proxy error: \(error?.localizedDescription ?? "no response")".utf8))
          return
        }
        var headers: [String: String] = ["Cache-Control": "no-store"]
        if let type = http.value(forHTTPHeaderField: "Content-Type") { headers["Content-Type"] = type }
        self.respond(task, status: http.statusCode, headers: headers, body: data ?? Data())
      }
    }
    lock.lock()
    running[id] = dataTask
    lock.unlock()
    dataTask.resume()
  }

  private func respond(_ task: WKURLSchemeTask, status: Int, headers: [String: String], body: Data) {
    let response = HTTPURLResponse(url: task.request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    task.didReceive(response)
    task.didReceive(body)
    task.didFinish()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private let schemeHandler = AppSchemeHandler()

  func applicationDidFinishLaunching(_ notification: Notification) {
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(schemeHandler, forURLScheme: scheme)
    config.websiteDataStore = .default() // keeps localStorage (watchlist, settings, drawings) between launches

    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.allowsMagnification = false
    if #available(macOS 13.3, *) { webView.isInspectable = true } // Safari ▸ Develop, for debugging
    webView.setValue(false, forKey: "drawsBackground") // no white flash while loading

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = "Basic chart"
    window.minSize = NSSize(width: 640, height: 480)
    window.backgroundColor = .black
    window.contentView = webView
    window.center()
    window.setFrameAutosaveName("MainWindow") // reopen at the last size and place
    window.makeKeyAndOrderFront(nil)

    webView.load(URLRequest(url: startURL))
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  // stay on the app's own page; open anything else in the default browser
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, url.scheme != scheme, action.targetFrame?.isMainFrame == true else {
      decisionHandler(.allow)
      return
    }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  @objc func reload(_ sender: Any?) { webView.reload() }
}

// ---- menus: app (About, Hide, Quit), Edit (copy / paste in text fields), View (Reload, Full Screen), Window

func buildMenu(_ app: NSApplication, _ delegate: AppDelegate) {
  let main = NSMenu()
  func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
    let item = NSMenuItem()
    let menu = NSMenu(title: title)
    items.forEach(menu.addItem)
    item.submenu = menu
    main.addItem(item)
    return menu
  }
  func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command,
            target: AnyObject? = nil) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.keyEquivalentModifierMask = mods
    i.target = target
    return i
  }
  _ = add("Basic chart", [
    item("About Basic chart", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
    .separator(),
    item("Hide Basic chart", #selector(NSApplication.hide(_:)), "h"),
    item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
    item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
    .separator(),
    item("Quit Basic chart", #selector(NSApplication.terminate(_:)), "q"),
  ])
  _ = add("Edit", [
    item("Undo", Selector(("undo:")), "z"),
    item("Redo", Selector(("redo:")), "z", [.command, .shift]),
    .separator(),
    item("Cut", #selector(NSText.cut(_:)), "x"),
    item("Copy", #selector(NSText.copy(_:)), "c"),
    item("Paste", #selector(NSText.paste(_:)), "v"),
    item("Select All", #selector(NSText.selectAll(_:)), "a"),
  ])
  _ = add("View", [
    item("Reload", #selector(AppDelegate.reload(_:)), "r", target: delegate),
    item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
  ])
  let window = add("Window", [
    item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
    item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
  ])
  app.windowsMenu = window
  app.mainMenu = main
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
buildMenu(app, delegate)
app.run()
