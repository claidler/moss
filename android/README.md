# Moss for Android

A Trusted Web Activity wrapper of the live Moss PWA at `https://bot.claidler.uk`. Same chat UI, login cookie, streaming, and web push — installed as a normal Android app with the Moss launcher icon.

Chrome 72+ is used when present. Devices without a TWA-capable browser fall back to a full-screen WebView.

## Install

1. Once (GitHub UI): **Actions → New workflow**, paste `android/github-workflow-android.yml`, save as `android.yml`. Signing secrets are already on the repo.
2. **Actions → Android APK → Run workflow**.
3. Download the `moss-android` artifact (`app-release.apk`).
4. On the phone, allow installing from that source and open the APK.

First launch shows Moss login. After Digital Asset Links verify (`https://bot.claidler.uk/.well-known/assetlinks.json`), Chrome hides the URL bar.

## Build locally

Needs JDK 17 and an Android SDK. Signing uses `android/keystore.properties` (gitignored; created by `scripts/generate-assets.py`).

```bash
cd android
./gradlew assembleRelease
```

APK: `app/build/outputs/apk/release/app-release.apk`.

Regenerate launcher/splash icons and (if missing) the keystore:

```bash
python3 scripts/generate-assets.py
```
