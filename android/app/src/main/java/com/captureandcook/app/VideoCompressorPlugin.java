package com.captureandcook.app;

import android.content.Intent;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;

import androidx.activity.result.ActivityResult;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.Effect;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.VideoEncoderSettings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.Collections;
import java.util.List;

/**
 * Pick a video and shrink it for sharing.
 *
 * Phones record at bitrates where a 35-second clip already exceeds 50 MB, the
 * per-file ceiling on Supabase Storage. Social apps re-encode before upload;
 * this does the same with Media3 Transformer: 720p H.264 at 3.5 Mbps plus AAC,
 * about 26 MB a minute. If that still exceeds the limit it retries at 540p.
 * HDR footage is tone-mapped to SDR so it doesn't come out washed out.
 *
 * JS: VideoCompressor.pickAndCompress({ maxSeconds, maxBytes })
 *   → { path, duration, size, width, height }
 *   rejects with code CANCELLED, TOO_LONG, TOO_LARGE, NOT_VIDEO or FAILED.
 * Emits "progress" events: { progress: 0…1 }.
 */
@CapacitorPlugin(name = "VideoCompressor")
public class VideoCompressorPlugin extends Plugin {

    private static final int[][] ATTEMPTS = {
        // { short side in px, video bitrate in bit/s }
        { 720, 3_500_000 },
        { 540, 2_000_000 },
    };

    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void pickAndCompress(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
            intent.setType("video/*");
        } else {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.setType("video/*");
            intent.addCategory(Intent.CATEGORY_OPENABLE);
        }
        startActivityForResult(call, intent, "onVideoPicked");
    }

    @ActivityCallback
    private void onVideoPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (uri == null) { call.reject("No video chosen.", "CANCELLED"); return; }

        String type = getContext().getContentResolver().getType(uri);
        if (type != null && !type.startsWith("video/")) {
            call.reject("That file isn't a video.", "NOT_VIDEO");
            return;
        }

        double maxSeconds = call.getDouble("maxSeconds", 60.0);
        long maxBytes = call.getLong("maxBytes", 48L * 1024 * 1024);

        long durationMs; int w, h, rotation;
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(getContext(), uri);
            durationMs = parse(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            w = (int) parse(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            h = (int) parse(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            rotation = (int) parse(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION));
        } catch (Exception e) {
            call.reject("Could not read that video.", "FAILED");
            return;
        } finally {
            try { mmr.release(); } catch (Exception ignored) { }
        }

        if (durationMs <= 0 || w <= 0 || h <= 0) { call.reject("Could not read that video.", "FAILED"); return; }
        if (durationMs > (long) ((maxSeconds + 0.5) * 1000)) {
            call.reject("Videos can be up to " + (int) maxSeconds + " seconds long.", "TOO_LONG");
            return;
        }

        // Displayed size, after the rotation the camera recorded.
        boolean turned = rotation == 90 || rotation == 270;
        int dispW = turned ? h : w, dispH = turned ? w : h;
        attempt(call, uri, 0, durationMs / 1000.0, Math.min(dispW, dispH), maxBytes);
    }

    private void attempt(PluginCall call, Uri uri, int i, double seconds, int shortSide, long maxBytes) {
        if (i >= ATTEMPTS.length) {
            call.reject("That video is too large even after compressing. Try a shorter clip.", "TOO_LARGE");
            return;
        }
        int target = ATTEMPTS[i][0], bitrate = ATTEMPTS[i][1];
        File out = new File(getContext().getCacheDir(), "share-" + System.currentTimeMillis() + ".mp4");

        // Only ever scale down.
        List<Effect> video = shortSide > target
            ? Collections.singletonList(Presentation.createForShortSide(target))
            : Collections.emptyList();
        List<AudioProcessor> audio = Collections.emptyList();
        EditedMediaItem item = new EditedMediaItem.Builder(MediaItem.fromUri(uri))
            .setEffects(new Effects(audio, video))
            .build();
        Composition composition = new Composition.Builder(new EditedMediaItemSequence.Builder(item).build())
            .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
            .build();

        Transformer transformer = new Transformer.Builder(getContext())
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(new DefaultEncoderFactory.Builder(getContext())
                .setRequestedVideoEncoderSettings(new VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                .setEnableFallback(true)
                .build())
            .addListener(new Transformer.Listener() {
                @Override
                public void onCompleted(Composition c, ExportResult r) {
                    main.removeCallbacksAndMessages(null);
                    long size = out.length();
                    if (size > 0 && size <= maxBytes) {
                        JSObject ret = new JSObject();
                        ret.put("path", out.getAbsolutePath());
                        ret.put("duration", seconds);
                        ret.put("size", size);
                        ret.put("width", r.width);
                        ret.put("height", r.height);
                        call.resolve(ret);
                    } else {
                        //noinspection ResultOfMethodCallIgnored
                        out.delete();
                        attempt(call, uri, i + 1, seconds, shortSide, maxBytes);
                    }
                }

                @Override
                public void onError(Composition c, ExportResult r, ExportException e) {
                    main.removeCallbacksAndMessages(null);
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    call.reject("Could not prepare that video.", "FAILED", e);
                }
            })
            .build();

        transformer.start(composition, out.getAbsolutePath());
        pollProgress(transformer, i);
    }

    private void pollProgress(Transformer transformer, int attempt) {
        ProgressHolder holder = new ProgressHolder();
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
                    JSObject p = new JSObject();
                    // A retry restarts from zero; keep the bar moving forward.
                    double pct = holder.progress / 100.0;
                    p.put("progress", attempt == 0 ? pct : 0.5 + pct / 2);
                    notifyListeners("progress", p);
                }
                main.postDelayed(this, 250);
            }
        }, 250);
    }

    private static long parse(String s) {
        try { return s == null ? 0 : Long.parseLong(s.trim()); } catch (NumberFormatException e) { return 0; }
    }
}
