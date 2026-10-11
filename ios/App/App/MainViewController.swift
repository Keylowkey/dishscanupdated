import UIKit
import Capacitor

/// The app's bridge controller. Exists to register plugins that live in this
/// app target rather than in an npm package: VideoCompressor and ShareIntake.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VideoCompressorPlugin())
        bridge?.registerPluginInstance(ShareIntakePlugin())
    }
}
