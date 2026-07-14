import os
from google import genai
from dotenv import load_dotenv

load_dotenv()
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

print("Attempting to connect to Gemini...")
response = client.models.generate_content(
    model="gemini-flash-lite-latest",
    contents="Say hello!",
)
print("Response:", response.text)