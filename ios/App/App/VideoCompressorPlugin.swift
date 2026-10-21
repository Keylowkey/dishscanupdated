import Foundation
import Capacitor
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

/// Pick a video from the photo library and shrink it for sharing.
///
/// Phones record at bitrates where a 35-second clip already exceeds 50 MB,
/// the per-file ceiling on Supabase Storage. Social apps re-encode before
/// uploading; this does the same: 720p H.264 at 2 Mbps (about 16 MB a
/// minute), and only if that is still too large, 540p at 1.2 Mbps. Every
/// view of a video is paid for in bandwidth, so the bitrate is set here
/// rather than left to Apple's 720p preset, which runs at ~7.5 Mbps.
/// HDR footage is converted to standard colour (see ClipEncoder).
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
        let attempts: [ClipEncoder.Settings] = [
            .init(shortSide: 720, videoBitrate: 2_000_000, audioBitrate: 96_000),
            .init(shortSide: 540, videoBitrate: 1_200_000, audioBitrate: 64_000)
        ]
        for settings in attempts {
            let out = FileManager.default.temporaryDirectory
                .appendingPathComponent("share-\(UUID().uuidString).mp4")
            var lastSent = -1.0
            do {
                // The encoder reports every frame; the progress bar needs 1% steps.
                try await ClipEncoder.encode(asset: asset, to: out, settings: settings) { [weak self] p in
                    guard p - lastSent >= 0.01 || p >= 1 else { return }
                    lastSent = p
                    self?.notifyListeners("progress", data: ["progress": p])
                }
            } catch {
                try? FileManager.default.removeItem(at: out)
                continue
            }
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
}

/// Re-encode a clip as H.264 at a set bitrate, scaled so its short side is at
/// most `shortSide`, in standard (Rec. 709) colour so HDR footage doesn't come
/// out washed out, with AAC audio. Orientation comes from the video
/// composition, which applies the track's rotation.
enum ClipEncoder {
    struct Settings { let shortSide: CGFloat; let videoBitrate: Int; let audioBitrate: Int }

    static func encode(asset: AVAsset, to out: URL, settings: Settings,
                       progress: @escaping (Double) -> Void) async throws {
        let duration = try await asset.load(.duration)
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw NSError(domain: "ClipEncoder", code: 1, userInfo: [NSLocalizedDescriptionKey: "No video track"])
        }
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)

        // Composition: rotation applied, SDR colour, scaled render size.
        let composition = try await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset)
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        // The composition renders upright at full size; the writer scales down.
        let natural = composition.renderSize
        let scale = min(1, settings.shortSide / min(natural.width, natural.height))
        let even = { (v: CGFloat) -> Int in Int((v * scale).rounded()) & ~1 }   // H.264 needs even sizes
        let outW = even(natural.width), outH = even(natural.height)

        let reader = try AVAssetReader(asset: asset)
        let videoOut = AVAssetReaderVideoCompositionOutput(videoTracks: [videoTrack], videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        ])
        videoOut.videoComposition = composition
        videoOut.alwaysCopiesSampleData = false
        reader.add(videoOut)

        var audioOut: AVAssetReaderAudioMixOutput?
        if !audioTracks.isEmpty {
            let a = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false
            ])
            a.alwaysCopiesSampleData = false
            if reader.canAdd(a) { reader.add(a); audioOut = a }
        }

        let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true   // moov atom first, so playback starts early
        let fps = try await videoTrack.load(.nominalFrameRate)
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outW,
            AVVideoHeightKey: outH,
            AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: settings.videoBitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
                AVVideoExpectedSourceFrameRateKey: fps > 0 ? Int(fps.rounded()) : 30
            ]
        ])
        videoIn.expectsMediaDataInRealTime = false
        writer.add(videoIn)

        var audioIn: AVAssetWriterInput?
        if audioOut != nil {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: settings.audioBitrate
            ])
            a.expectsMediaDataInRealTime = false
            writer.add(a)
            audioIn = a
        }

        guard reader.startReading() else { throw reader.error ?? NSError(domain: "ClipEncoder", code: 2) }
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "ClipEncoder", code: 3) }
        writer.startSession(atSourceTime: .zero)

        let total = max(duration.seconds, 0.1)
        let queue = DispatchQueue(label: "clip-encoder")
        let group = DispatchGroup()

        func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderOutput, reportsProgress: Bool) {
            group.enter()
            input.requestMediaDataWhenReady(on: queue) {
                while input.isReadyForMoreMediaData {
                    guard reader.status == .reading, let sample = output.copyNextSampleBuffer() else {
                        input.markAsFinished()
                        group.leave()
                        return
                    }
                    if reportsProgress {
                        progress(min(1, CMSampleBufferGetPresentationTimeStamp(sample).seconds / total))
                    }
                    if !input.append(sample) {
                        reader.cancelReading()
                        input.markAsFinished()
                        group.leave()
                        return
                    }
                }
            }
        }
        pump(videoIn, videoOut, reportsProgress: true)
        if let ai = audioIn, let ao = audioOut { pump(ai, ao, reportsProgress: false) }

        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            group.notify(queue: queue) { done.resume() }
        }
        if reader.status == .failed || writer.status == .failed {
            writer.cancelWriting()
            throw writer.error ?? reader.error ?? NSError(domain: "ClipEncoder", code: 4)
        }
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? NSError(domain: "ClipEncoder", code: 5) }
        progress(1)
    }
}
