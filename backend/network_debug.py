import requests
import socket
import ssl
import sys

# 1. Test basic connectivity to Google's API endpoint without the SDK
url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent"
print("--- TEST 1: RAW HTTP REQUEST ---")
try:
    # A simple GET request just to see if we can touch the server
    response = requests.get("https://google.com", timeout=10)
    print(f"Connection to Google successful: Status {response.status_code}")
except Exception as e:
    print(f"FAILED: Could not reach Google. Error: {e}")

# 2. Check DNS Resolution
print("\n--- TEST 2: DNS RESOLUTION ---")
try:
    ip = socket.gethostbyname("generativelanguage.googleapis.com")
    print(f"DNS resolved API endpoint to: {ip}")
except Exception as e:
    print(f"DNS FAILED: Could not resolve API endpoint. Error: {e}")

# 3. Check for SSL/TLS Interception (Common on Macs with security software)
print("\n--- TEST 3: SSL CERTIFICATE CHECK ---")
try:
    ctx = ssl.create_default_context()
    with socket.create_connection(("generativelanguage.googleapis.com", 443), timeout=10) as sock:
        with ctx.wrap_socket(sock, server_hostname="generativelanguage.googleapis.com") as ssock:
            cert = ssock.getpeercert()
            print("SSL Certificate received successfully.")
            print(f"Issuer: {cert.get('issuer')}")
except Exception as e:
    print(f"SSL FAILED: Your Mac is rejecting the connection. This usually means a VPN, Zscaler, or Antivirus is intercepting SSL.")
    print(f"Error: {e}")