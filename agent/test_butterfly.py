import requests
import json

url = "http://127.0.0.1:8765/api/butterfly/simulate"
payload = {
    "project_id": "test_proj_error_500",
    "supposition": "如果反派没死"
}

try:
    resp = requests.post(url, json=payload)
    print(f"Status Code: {resp.status_code}")
    print(f"Response: {resp.text}")
except Exception as e:
    print(f"Request failed: {e}")
