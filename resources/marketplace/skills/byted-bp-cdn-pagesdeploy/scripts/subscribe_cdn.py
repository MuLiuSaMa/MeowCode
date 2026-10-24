#!/usr/bin/env python3
"""
Subscribe to BytePlus CDN service via OpenAPI.
Uses V4 signature (HMAC-SHA256) for authentication.

API: SubscribeCdnService
Service: CDN
Version: 2021-03-01
Region: overseas
PayType: pay-as-you-go (byTraffic95)
"""

import sys
import json
import hashlib
import hmac
import datetime
import urllib.request
import urllib.parse
import urllib.error


# BytePlus OpenAPI constants
SERVICE = "CDN"
VERSION = "2021-03-01"
ACTION = "SubscribeCdnService"
HOST = "cdn.byteplusapi.com"
REGION = "ap-singapore-1"
CONTENT_TYPE = "application/json"


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def get_signature_key(secret_key: str, date_stamp: str, region: str, service: str) -> bytes:
    k_date = sign(secret_key.encode("utf-8"), date_stamp)
    k_region = sign(k_date, region)
    k_service = sign(k_region, service)
    k_signing = sign(k_service, "request")
    return k_signing


def make_request(access_key: str, secret_key: str) -> dict:
    # Request body
    body = json.dumps({
        "Regions": [
            {
                "Region": "overseas",
                "PayType": "byTraffic95"
            }
        ]
    })

    # Timestamps
    now = datetime.datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    # Canonical request components
    method = "POST"
    canonical_uri = "/"
    canonical_querystring = (
        f"Action={ACTION}&Version={VERSION}"
    )

    # Headers
    payload_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    headers_to_sign = {
        "content-type": CONTENT_TYPE,
        "host": HOST,
        "x-date": amz_date,
    }
    signed_headers = ";".join(sorted(headers_to_sign.keys()))
    canonical_headers = ""
    for key in sorted(headers_to_sign.keys()):
        canonical_headers += f"{key}:{headers_to_sign[key]}\n"

    # Canonical request
    canonical_request = "\n".join([
        method,
        canonical_uri,
        canonical_querystring,
        canonical_headers,
        signed_headers,
        payload_hash,
    ])

    # String to sign
    algorithm = "HMAC-SHA256"
    credential_scope = f"{date_stamp}/{REGION}/{SERVICE.lower()}/request"
    string_to_sign = "\n".join([
        algorithm,
        amz_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    # Signing key
    signing_key = get_signature_key(secret_key, date_stamp, REGION, SERVICE.lower())
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    # Authorization header
    authorization = (
        f"{algorithm} "
        f"Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )

    # Make HTTP request
    url = f"https://{HOST}/?{canonical_querystring}"
    req = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": CONTENT_TYPE,
            "Host": HOST,
            "X-Date": amz_date,
            "Authorization": authorization,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            resp_body = response.read().decode("utf-8")
            return json.loads(resp_body)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8") if e.fp else ""
        try:
            return json.loads(error_body)
        except json.JSONDecodeError:
            return {"ResponseMetadata": {"Error": {"Code": str(e.code), "Message": error_body}}}
    except Exception as e:
        return {"ResponseMetadata": {"Error": {"Code": "NetworkError", "Message": str(e)}}}


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 subscribe_cdn.py <access_key> <secret_key>", file=sys.stderr)
        sys.exit(1)

    access_key = sys.argv[1]
    secret_key = sys.argv[2]

    print(f"[INFO] Calling SubscribeCdnService API...")
    print(f"[INFO] Endpoint: https://{HOST}")
    print(f"[INFO] Params: Region=overseas, PayType=byTraffic95")

    result = make_request(access_key, secret_key)

    # Check for errors
    metadata = result.get("ResponseMetadata", {})
    error = metadata.get("Error")

    if error:
        error_code = error.get("Code", "Unknown")
        error_msg = error.get("Message", "Unknown error")
        print(f"[ERROR] API returned error: {error_code} - {error_msg}", file=sys.stderr)
        sys.exit(1)

    # Success
    print(f"[OK] CDN service subscribed successfully!")
    preorder = result.get("Result", {}).get("PreorderNumbers", [])
    if preorder:
        print(f"[INFO] Preorder numbers: {preorder}")

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
