import UIKit
import Capacitor

/// The app's bridge controller. Exists to register plugins that live in this
/// app target rather than in an npm package — currently VideoCompressor.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VideoCompressorPlugin())
    }
}
