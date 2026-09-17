# Moss for Android

A Trusted Web Activity wrapper of **your** deployed Moss PWA (default placeholder: `https://moss.example.com`). Same chat UI, login cookie, streaming, and web push — installed as a normal Android app with the Moss launcher icon.

Chrome 72+ is used when present. Devices without a TWA-capable browser fall back to a full-screen WebView.

Your deployment identity comes from three environment variables, so nothing personal needs to be committed:

| Var | Default | Purpose |
| --- | --- | --- |
| `MOSS_ANDROID_PACKAGE` | `com.example.moss` | Application id / Java package (or `-PmossPackage=`) |
| `MOSS_ANDROID_HOST` | `moss.example.com` | Hostname of your deployed PWA |
| `MOSS_KEYSTORE_DN` | `CN=Moss, OU=Moss, O=Moss` | X.500 subject baked into the generated release keystore |

## Set up once

```bash
MOSS_ANDROID_PACKAGE=com.you.moss MOSS_ANDROID_HOST=moss.example.com \
python3 scripts/generate-assets.py
```

This regenerates launcher/splash icons, creates `keystore.jks` + `keystore.properties` + `.keypass` (all gitignored) if missing, and rewrites `app/src/main/res/values/strings.xml`, `../.well-known/assetlinks.json`, and `sha256.txt` with your package, host, and keystore fingerprint. Those three generated files ship as neutral placeholders — keep your generated versions as local changes, or commit them if you don't mind publishing them.

Export the keystore for CI and save as repository secrets (`ANDROID_KEYSTORE_BASE64` = `base64 -w0 keystore.jks`, `ANDROID_KEYSTORE_PASSWORD` = contents of `.keypass`), then copy `github-workflow-android.yml` to `.github/workflows/android.yml`.

## Build via GitHub Actions

1. **Actions → Android APK → Run workflow**.
2. Download the `moss-android` artifact (`app-release.apk`).
3. On the phone, allow installing from that source and open the APK.

First launch shows Moss login. After Digital Asset Links verify (`https://<your-host>/.well-known/assetlinks.json` — served automatically by the Moss server), Chrome hides the URL bar.

## Build locally

Needs JDK 17 and an Android SDK. Signing uses `keystore.properties` (gitignored; created by `scripts/generate-assets.py`).

```bash
./gradlew assembleRelease
```

APK: `app/build/outputs/apk/release/app-release.apk`.
