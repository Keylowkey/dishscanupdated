import UIKit
import UniformTypeIdentifiers

/// "Capture & Cook" in the iOS share sheet.
///
/// Instagram, TikTok, YouTube and Safari share a link. This takes it, hands it
/// to the app through com.captureandcook.app://import?url=…, which the app
/// already handles by importing the recipe, and gets out of the way.
///
/// The link is also left in the shared App Group. If iOS doesn't let the
/// extension open the app, the sheet says so, and the app imports the link
/// the next time it comes to the foreground (ShareIntake.getPending()).
final class ShareViewController: UIViewController {

    static let appGroup = "group.com.captureandcook.app"
    static let pendingKey = "pendingShareURL"

    private let card = UIView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let doneButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        buildUI()
        Task { await handle() }
    }

    // MARK: - Flow

    private func handle() async {
        guard let link = await sharedLink() else {
            show(title: "No link found",
                 message: "Share a post or video link to get its recipe.",
                 done: true)
            return
        }
        UserDefaults(suiteName: Self.appGroup)?.set(link.absoluteString, forKey: Self.pendingKey)

        var comps = URLComponents()
        comps.scheme = "com.captureandcook.app"
        comps.host = "import"
        comps.queryItems = [URLQueryItem(name: "url", value: link.absoluteString)]

        if let deep = comps.url, openContainingApp(deep) {
            // The app takes it from here; it clears the App Group copy.
            try? await Task.sleep(nanoseconds: 300_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            show(title: "Saved to Capture & Cook",
                 message: "Open Capture & Cook and your recipe will be waiting.",
                 done: true)
        }
    }

    /// The first web link in what was shared: a URL item, or a URL inside
    /// shared text (Instagram sometimes shares "caption … https://…").
    private func sharedLink() async -> URL? {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let item = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier),
               let url = item as? URL, let s = url.scheme?.lowercased(), s == "http" || s == "https" {
                return url
            }
        }
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
               let url = Self.firstWebURL(in: text) {
                return url
            }
        }
        for item in items {
            if let text = item.attributedContentText?.string, let url = Self.firstWebURL(in: text) { return url }
        }
        return nil
    }

    static func firstWebURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range) {
            if let url = match.url, let s = url.scheme?.lowercased(), s == "http" || s == "https" { return url }
        }
        return nil
    }

    /// Extensions can't call UIApplication.shared; the application object is
    /// reachable through the responder chain instead.
    private func openContainingApp(_ url: URL) -> Bool {
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return true
            }
            responder = r.next
        }
        return false
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    // MARK: - UI

    private func buildUI() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)

        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 20
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        titleLabel.text = "Getting your recipe…"
        titleLabel.font = .systemFont(ofSize: 17, weight: .bold)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0

        messageLabel.text = "Opening Capture & Cook"
        messageLabel.font = .systemFont(ofSize: 14)
        messageLabel.textColor = .secondaryLabel
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0

        doneButton.setTitle("Done", for: .normal)
        doneButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        doneButton.addTarget(self, action: #selector(finish), for: .touchUpInside)
        doneButton.isHidden = true

        spinner.startAnimating()

        let stack = UIStackView(arrangedSubviews: [spinner, titleLabel, messageLabel, doneButton])
        stack.axis = .vertical
        stack.spacing = 10
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            card.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20)
        ])
    }

    private func show(title: String, message: String, done: Bool) {
        spinner.stopAnimating()
        spinner.isHidden = true
        titleLabel.text = title
        messageLabel.text = message
        doneButton.isHidden = !done
    }
}
