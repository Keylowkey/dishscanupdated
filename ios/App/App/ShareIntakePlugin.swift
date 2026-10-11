import Foundation
import Capacitor

/// Links shared to Capture & Cook from the share sheet.
///
/// The share extension (ios/App/ShareExtension) normally opens the app with
/// com.captureandcook.app://import?url=…, which the web layer handles. It also
/// leaves the link in the shared App Group, in case iOS doesn't let it open
/// the app; this hands that link over the next time the app comes forward.
///
/// JS: ShareIntake.getPending() → { text } | {}   (consumed once)
/// Same name and shape as the Android plugin, so the web layer needn't care.
@objc(ShareIntakePlugin)
public class ShareIntakePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareIntakePlugin"
    public let jsName = "ShareIntake"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise)
    ]

    static let appGroup = "group.com.captureandcook.app"
    static let pendingKey = "pendingShareURL"

    @objc func getPending(_ call: CAPPluginCall) {
        let defaults = UserDefaults(suiteName: Self.appGroup)
        guard let text = defaults?.string(forKey: Self.pendingKey), !text.isEmpty else {
            call.resolve([:])
            return
        }
        defaults?.removeObject(forKey: Self.pendingKey)
        call.resolve(["text": text])
    }
}
