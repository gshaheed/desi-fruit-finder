# Desi Fruit Finder — Android app

A thin native wrapper around the live site (https://gshaheed.github.io/desi-fruit-finder/) so it installs and launches like a regular Android app, with its own icon, splash-free launch, pull-to-refresh, and back-button navigation. It doesn't reimplement the site — all functionality (fruit browser, Fruit Swipe, cart, checkout) comes from the live pages, loaded in a `WebView`.

- Links to other domains (vendor sites, Stripe Checkout, FormSubmit) open in the system browser instead of the in-app WebView.
- `localStorage` (used for the cart) is enabled, so the cart persists between app launches.

## Building

Requires JDK 17 and the Android SDK (`platform-tools`, `platforms;android-34`, `build-tools;34.0.0`). Point `sdk.dir` in `local.properties` (not checked in) at your SDK, then:

```bash
cd android
gradle assembleDebug
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`. It's signed with the default debug keystore, so it installs directly on a device via `adb install` or by copying it over — no Play Store needed. For a Play Store release, you'd need a real signing config and `assembleRelease` instead.

Easiest path if you don't already have the SDK set up: open this `android/` folder directly in Android Studio, which will offer to install everything for you.
