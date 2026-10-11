package com.captureandcook.app;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives links shared to Capture & Cook from other apps' share sheets
 * (Instagram, TikTok, YouTube, a browser…), so the app appears there and
 * opens straight into importing the recipe.
 *
 * The manifest routes ACTION_SEND text/plain to MainActivity. A share that
 * launches the app is read from the launch intent in load(); one that
 * arrives while it's running comes through handleOnNewIntent().
 *
 * JS: ShareIntake.getPending() → { text } | {}   (cold start; consumed once)
 *     ShareIntake.addListener('shared', ({ text }) => …)
 */
@CapacitorPlugin(name = "ShareIntake")
public class ShareIntakePlugin extends Plugin {

    private String pending;

    @Override
    public void load() {
        take(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = take(intent);
        if (text != null) {
            JSObject data = new JSObject();
            data.put("text", text);
            // retainUntilConsumed: delivered even if JS hasn't attached yet.
            notifyListeners("shared", data, true);
            pending = null;
        }
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject ret = new JSObject();
        if (pending != null) ret.put("text", pending);
        pending = null;
        call.resolve(ret);
    }

    /** Pull shared text out of an intent once, so a rotation can't replay it. */
    private String take(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return null;
        CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (cs == null) return null;
        String text = cs.toString().trim();
        // Consumed: a recreated activity sees an ordinary launch, not the share.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_TEXT);
        if (text.isEmpty()) return null;
        pending = text;
        return text;
    }
}
