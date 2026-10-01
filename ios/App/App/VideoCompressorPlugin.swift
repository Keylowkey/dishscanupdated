import Foundation
import Capacitor
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

/// Pick a video from the photo library and shrink it for sharing.
///
/// Phones record at bitrates where a 35-second clip already exceeds 50 MB,
/// the per-file ceiling on Supabase Storage. Social apps re-encode before
/// uploading; this does the same. A clip is exported at 720p H.264, and only
/// if that is still too large, at 540p. Apple's exporter handles iPhone HDR
/// footage correctly, which hand-rolled encoding easily gets wrong.
///
/// JS: VideoCompressor.pickAndCompress({ maxSeconds, maxBytes })
///   → { path, duration, size, width, height }
///   rejects with code CANCELLED, TOO_LONG, TOO_LARGE, NOT_VIDEO or FAILED.
/// Emits "progress" events: { progress: 0…1 }.
@objc(VideoCompressorPlugin)
public class VideoCompressorPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate {
    public let identifier = "VideoCompressorPlugin"
    public let jsName = "VideoCompressor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickAndCompress", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    @objc func pickAndCompress(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var config = PHPickerConfiguration()
            config.filter = .videos
            config.selectionLimit = 1
            // The original file; we do the compressing ourselves.
            config.preferredAssetRepresentationMode = .current
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = self
            self.pendingCall = call
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let call = pendingCall else { return }
        pendingCall = nil

        guard let provider = results.first?.itemProvider else {
            call.reject("No video chosen.", "CANCELLED"); return
        }
        let movie = UTType.movie.identifier
        guard provider.hasItemConformingToTypeIdentifier(movie) else {
            call.reject("That file isn't a video.", "NOT_VIDEO"); return
        }
        provider.loadFileRepresentation(forTypeIdentifier: movie) { url, _ in
            guard let url = url else {
                call.reject("Could not open that video.", "FAILED"); return
            }
            // The system deletes `url` when this closure returns, so keep a copy.
            let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension
            let src = FileManager.default.temporaryDirectory
                .appendingPathComponent("pick-\(UUID().uuidString).\(ext)")
            do { try FileManager.default.copyItem(at: url, to: src) } catch {
                call.reject("Could not open that video.", "FAILED"); return
            }
            Task { await self.compress(src: src, call: call) }
        }
    }

    private func compress(src: URL, call: CAPPluginCall) async {
        defer { try? FileManager.default.removeItem(at: src) }
        let maxSeconds = call.getDouble("maxSeconds") ?? 60
        let maxBytes = Int64(call.getInt("maxBytes") ?? 48 * 1024 * 1024)
        let asset = AVURLAsset(url: src)

        let duration: Double
        do { duration = try await asset.load(.duration).seconds } catch {
            call.reject("Could not read that video.", "FAILED"); return
        }
        if !duration.isFinite || duration <= 0 {
            call.reject("Could not read that video.", "FAILED"); return
        }
        if duration > maxSeconds + 0.5 {
            call.reject("Videos can be up to \(Int(maxSeconds)) seconds long.", "TOO_LONG"); return
        }

        // 720p first; fall back to 540p only when 720p is still over the limit.
        for preset in [AVAssetExportPreset1280x720, AVAssetExportPreset960x540] {
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("share-\(UUID().uuidString).mp4")
            guard await export(asset: asset, preset: preset, to: out) else { continue }
            let size = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int64) ?? 0
            if size > 0 && size <= maxBytes {
                var w = 0, h = 0
                if let track = try? await AVURLAsset(url: out).loadTracks(withMediaType: .video).first,
                   let natural = try? await track.load(.naturalSize),
                   let t = try? await track.load(.preferredTransform) {
                    let r = CGRect(origin: .zero, size: natural).applying(t)
                    w = Int(abs(r.width)); h = Int(abs(r.height))
                }
                call.resolve(["path": out.path, "duration": duration,
                              "size": size, "width": w, "height": h])
                return
            }
            try? FileManager.default.removeItem(at: out)
        }
        call.reject("That video is too large even after compressing. Try a shorter clip.", "TOO_LARGE")
    }

    private func export(asset: AVAsset, preset: String, to out: URL) async -> Bool {
        guard let session = AVAssetExportSession(asset: asset, presetName: preset) else { return false }
        session.outputURL = out
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true   // moov atom first, so playback starts early

        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self, weak session] _ in
            guard let s = session else { return }
            self?.notifyListeners("progress", data: ["progress": Double(s.progress)])
        }
        RunLoop.main.add(timer, forMode: .common)
        // A timer must be invalidated on the run loop it was scheduled on.
        defer { DispatchQueue.main.async { timer.invalidate() } }

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { done.resume() }
        }
        return session.status == .completed
    }
}
