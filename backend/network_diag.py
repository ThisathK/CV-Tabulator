import os
import sys

# Force Python to ignore existing proxy environment variables
os.environ['http_proxy'] = ''
os.environ['https_proxy'] = ''
os.environ['all_proxy'] = ''

print("Proxy environment variables cleared.")

try:
    from google import genai
    from dotenv import load_dotenv
    
    load_dotenv()
    
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        print("CRITICAL: GEMINI_API_KEY not found in .env!")
        sys.exit(1)
        
    print(f"Initializing client with key (first 4 chars): {key[:4]}...")
    client = genai.Client(api_key=key)
    
    print("Attempting to connect (should be instant)...")
    response = client.models.generate_content(
        model="gemini-flash-lite-latest",
        contents="Say hello!",
    )
    print("SUCCESS! Response:", response.text)
    
except Exception as e:
    print(f"FAILED: {e}")