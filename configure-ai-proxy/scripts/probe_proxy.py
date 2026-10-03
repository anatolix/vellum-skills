#!/usr/bin/env python3
"""Probe a selected proxy without an API key, model call, or credential output.

Only reads settings. Does not prove the target application loaded those settings.
Uses curl --disable to ignore .curlrc and sends the proxy URL over stdin, not argv.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import unquote, urlsplit


PROXY_KEYS = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
MARKER = "\n__AI_PROXY_PROBE_METRICS__\n"
TARGETS = {
    "anthropic": "https://api.anthropic.com/v1/models",
    "openai": "https://api.openai.com/v1/models",
}


def read_proxy(source, config_path):
    if source == "env":
        if config_path:
            raise ValueError("--config is only valid for claude or vscode")
        values = os.environ
    else:
        if config_path:
            path = Path(config_path).expanduser()
        elif source == "claude":
            path = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / "settings.json"
        else:
            path = Path.home() / "Library/Application Support/Code/User/settings.json"
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            raise ValueError("Config is not plain JSON; JSONC requires a JSONC-aware reader") from None
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        if source == "claude":
            values = data.get("env", {})
        else:
            values = {}
            for entry in data.get("claudeCode.environmentVariables", []):
                name, value = entry["name"], entry["value"]
                if name in values and values[name] != value:
                    raise ValueError("Conflicting duplicate VS Code environment variable")
                values[name] = value
    if not isinstance(values, dict) and source != "env":
        raise ValueError("Expected an environment mapping")
    for name in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"):
        value = values.get(name)
        if value:
            if not isinstance(value, str):
                raise ValueError("Proxy URL must be a string")
            return value
    raise ValueError("No HTTP/HTTPS proxy in selected source; refusing a direct request")


def curl_quote(value):
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Control characters in proxy URL")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def probe(proxy_url, target):
    parts = urlsplit(proxy_url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("Expected an http:// or https:// proxy URL")
    if parts.query or parts.fragment or parts.path not in ("", "/") or "${" in proxy_url:
        raise ValueError("Invalid or unexpanded proxy URL")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    env = {k: v for k, v in os.environ.items() if k.lower() not in PROXY_KEYS}
    cmd = [
        "curl", "--disable", "--config", "-", "--silent", "--show-error",
        "--connect-timeout", "15", "--max-time", "30", "--noproxy", "",
    ]
    if target == "anthropic":
        cmd += ["--header", "anthropic-version: 2023-06-01"]
    cmd += [
        "--write-out",
        MARKER + "%{http_code} %{http_connect} %{ssl_verify_result} %{proxy_ssl_verify_result}",
        TARGETS[target],
    ]
    result = subprocess.run(
        cmd, input="proxy = " + curl_quote(proxy_url) + "\n", env=env,
        capture_output=True, text=True, timeout=35,
    )
    body, separator, metrics = result.stdout.rpartition(MARKER)
    fields = metrics.split() if separator else []
    if len(fields) != 4:
        fields = ["unavailable"] * 4
    http, connect, tls, proxy_tls = fields
    transport_ok = (
        result.returncode == 0 and connect == "200" and tls == "0"
        and (parts.scheme != "https" or proxy_tls == "0") and http != "000"
    )
    output = {
        "target": TARGETS[target],
        "proxy": {"scheme": parts.scheme, "host": parts.hostname, "port": port},
        "curl_exit": result.returncode,
        "http_status": http,
        "proxy_connect_status": connect,
        "target_tls_verify_code": tls,
        "proxy_tls_verify_code": proxy_tls if parts.scheme == "https" else "not_applicable_http_proxy",
        "transport_ok": transport_ok,
        "application_access_verified": False,
        "note": "An HTTP response, including 401, does not verify model access or the app's active route.",
    }
    try:
        error = json.loads(body).get("error")
        if isinstance(error, dict) and isinstance(error.get("type"), str):
            error_type = error["type"]
            if len(error_type) < 80 and all(c.isalnum() or c == "_" for c in error_type):
                output["api_error_type"] = error_type
    except (ValueError, AttributeError):
        pass
    # Print only stderr, never headers/body/config; redact known userinfo if curl includes it.
    if result.stderr.strip():
        diagnostic = result.stderr.strip().replace(proxy_url, "<proxy-url>")
        for secret in (parts.username, parts.password):
            if secret:
                diagnostic = diagnostic.replace(secret, "<redacted>").replace(unquote(secret), "<redacted>")
        output["diagnostic"] = diagnostic[:1200]
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["env", "claude", "vscode"], default="env")
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--config", help="Optional settings JSON path for claude/vscode")
    args = parser.parse_args()
    try:
        output = probe(read_proxy(args.source, args.config), args.target)
    except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        # Exception details can contain argv, paths or input; report only a safe category.
        print(json.dumps({"error": type(exc).__name__, "transport_ok": False,
                          "hint": "Check source file/schema, curl availability, proxy URL and timeout. No direct fallback was attempted."}))
        return 2
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["transport_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
