package com.captureandcook.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app rather than an npm package must be
        // registered before the bridge starts.
        registerPlugin(VideoCompressorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
