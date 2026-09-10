#!/usr/bin/env python3
"""Generate Android launcher/splash icons and a release keystore."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parents[2]
ANDROID = ROOT / "android"
APP_RES = ANDROID / "app" / "src" / "main" / "res"
KEYSTORE = ANDROID / "keystore.jks"
PROPS = ANDROID / "keystore.properties"
ALIAS = "moss"

spec = importlib.util.spec_from_file_location("make_icons", ROOT / "make-icons.py")
make_icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_icons)


def write_png(path: Path, blob: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)


def white_silhouette(size: int) -> bytes:
    pix = bytearray(size * size * 4)
    inner = size * (1 - 2 * 0.08)
    origin = size * 0.08
    scale = inner / 64.0

    def to_px(x, y):
        return origin + x * scale, origin + y * scale

    bcx, bcy = to_px(32.2, 33.0)
    brx, bry = 26.2 * scale, 27.4 * scale
    for y in range(size):
        for x in range(size):
            cover = make_icons.ellipse_cover(x + 0.5, y + 0.5, bcx, bcy, brx, bry)
            a = int(round(max(0.0, min(1.0, cover)) * 255))
            i = (y * size + x) * 4
            pix[i : i + 4] = bytes((255, 255, 255, a))
    return make_icons.png_rgba(size, size, pix)


def ensure_keystore() -> str:
    if not KEYSTORE.exists():
        password = secrets.token_urlsafe(24)
        pass_file = ANDROID / ".keypass"
        pass_file.write_text(password + "\n")
        os.chmod(pass_file, 0o600)
        subprocess.check_call(
            [
                "keytool",
                "-genkeypair",
                "-keystore",
                str(KEYSTORE),
                "-alias",
                ALIAS,
                "-keyalg",
                "RSA",
                "-keysize",
                "2048",
                "-validity",
                "10000",
                "-dname",
                "CN=Moss, OU=claidler, O=claidler, L=London, ST=England, C=GB",
                "-storepass:file",
                str(pass_file),
                "-keypass:file",
                str(pass_file),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.chmod(KEYSTORE, 0o600)
        PROPS.write_text(
            "\n".join(
                [
                    "storeFile=keystore.jks",
                    f"storePassword={password}",
                    f"keyAlias={ALIAS}",
                    f"keyPassword={password}",
                    "",
                ]
            )
        )
        os.chmod(PROPS, 0o600)
    props = dict(
        line.split("=", 1)
        for line in PROPS.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#") and "=" in line
    )
    pass_file = ANDROID / ".keypass"
    if not pass_file.exists():
        pass_file.write_text(props["storePassword"] + "\n")
        os.chmod(pass_file, 0o600)
    cert = subprocess.check_output(
        [
            "keytool",
            "-exportcert",
            "-keystore",
            str(KEYSTORE),
            "-alias",
            ALIAS,
            "-storepass:file",
            str(pass_file),
        ]
    )
    digest = hashlib.sha256(cert).hexdigest().upper()
    return ":".join(digest[i : i + 2] for i in range(0, 64, 2))


def write_strings(fingerprint: str) -> None:
    statements = json.dumps(
        [
            {
                "relation": ["delegate_permission/common.handle_all_urls"],
                "target": {
                    "namespace": "android_app",
                    "package_name": "uk.claidler.moss",
                    "sha256_cert_fingerprints": [fingerprint],
                },
            }
        ]
    )
    escaped = xml_escape(statements).replace('"', "&" + "quot;")
    path = APP_RES / "values" / "strings.xml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="appName">Moss</string>
    <string name="launcherName">Moss</string>
    <string name="launchUrl">https://bot.claidler.uk/</string>
    <string name="hostName">bot.claidler.uk</string>
    <string name="webManifestUrl">https://bot.claidler.uk/manifest.webmanifest</string>
    <string name="providerAuthority">uk.claidler.moss.fileprovider</string>
    <string name="fallbackType">webview</string>
    <string name="orientation">default</string>
    <string name="generatorApp">moss-android</string>
    <string name="assetStatements">{escaped}</string>
</resources>
"""
    )


def write_assetlinks(fingerprint: str) -> None:
    path = ROOT / ".well-known" / "assetlinks.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            [
                {
                    "relation": ["delegate_permission/common.handle_all_urls"],
                    "target": {
                        "namespace": "android_app",
                        "package_name": "uk.claidler.moss",
                        "sha256_cert_fingerprints": [fingerprint],
                    },
                }
            ],
            indent=2,
        )
        + "\n"
    )


def main() -> int:
    paper = (250, 250, 248, 255)
    densities = {
        "mdpi": 48,
        "hdpi": 72,
        "xhdpi": 96,
        "xxhdpi": 144,
        "xxxhdpi": 192,
    }
    for name, size in densities.items():
        png = make_icons.render(size, pad=0.08, bg=paper)
        write_png(APP_RES / f"mipmap-{name}" / "ic_launcher.png", png)
        write_png(APP_RES / f"mipmap-{name}" / "ic_launcher_round.png", png)

    write_png(
        APP_RES / "drawable" / "ic_launcher_foreground.png",
        make_icons.render(432, pad=0.22, bg=(0, 0, 0, 0)),
    )
    write_png(
        APP_RES / "drawable" / "splash.png",
        make_icons.render(512, pad=0.28, bg=paper),
    )
    write_png(APP_RES / "drawable" / "ic_notification_icon.png", white_silhouette(96))

    fingerprint = ensure_keystore()
    write_strings(fingerprint)
    write_assetlinks(fingerprint)
    (ANDROID / "sha256.txt").write_text(fingerprint + "\n")
    print(fingerprint)
    return 0


if __name__ == "__main__":
    sys.exit(main())
