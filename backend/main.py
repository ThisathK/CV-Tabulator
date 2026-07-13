import asyncio
import json
import os
import re
import uuid
from typing import List

import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel

load_dotenv()  # reads GEMINI_API_KEY from a local .env file

app = FastAPI(title="CV Tabulator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = "gemini-3.5-flash"
GEMINI_TIMEOUT_MS = 15_000
REQUEST_TIMEOUT_SECONDS = 20

# The client is created once at startup and reused across requests.
gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

SYSTEM_PROMPT = """
You are an HR data extraction specialist. You will be given the raw text of a
candidate's resume/CV. Extract only the following fields, exactly as they
appear or can be directly inferred from the document.

You MUST return the data as a raw JSON object with EXACTLY these keys:
- "name" (string)
- "email" (string)
- "phone" (string)
- "experience_years" (integer, calculate if not explicitly stated, or 0 if missing)
- "top_skills" (array of strings, max 6)
- "highest_education" (string)

Rules:
- Output ONLY valid JSON. 
- Do not include markdown code blocks, backticks, or any other prose text.
- If a field is genuinely not present, use an empty string (or 0 for experience_years).
- Never fabricate contact details.
""".strip()


class ResumeData(BaseModel):
    name: str
    email: str
    phone: str
    experience_years: int
    top_skills: List[str]
    highest_education: str


def _fallback_result(reason: str) -> dict:
    """Safe, table-shaped result returned whenever LLM parsing can't be trusted."""
    return {
        "name": "Failed to parse",
        "email": "Failed to parse",
        "phone": "Failed to parse",
        "experience_years": 0,
        "top_skills": "Failed to parse",
        "highest_education": "Failed to parse",
        "error": reason,
    }


def parse_resume_with_llm(extracted_text: str) -> dict:
    """
    Sends the extracted resume text to the Gemini API and returns structured
    candidate data matching our table schema. Uses "soft parsing" to avoid
    503 timeouts on the free tier.
    """
    if gemini_client is None:
        return _fallback_result("GEMINI_API_KEY is not configured on the server")

    if not extracted_text or not extracted_text.strip():
        return _fallback_result("No text could be extracted from this PDF")

    try:
        # We use your original HttpOptions placement, but drop response_schema
        response = gemini_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=f"Resume text:\n\n{extracted_text}",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                response_mime_type="application/json",
                temperature=0,
                http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS),
            ),
        )
    except Exception as exc:
        return _fallback_result(f"Gemini API request failed: {exc}")

    try:
        raw_text = response.text.strip()
        cleaned_text = re.sub(r'^```(?:json)?\s*', '', raw_text, flags=re.IGNORECASE)
        cleaned_text = re.sub(r'\s*```$', '', cleaned_text)
        
        parsed = ResumeData.model_validate_json(cleaned_text)
        
    except Exception as exc:
        return _fallback_result(f"Gemini returned invalid/unparseable JSON: {exc}")

    result = parsed.model_dump()
    result["top_skills"] = ", ".join(result["top_skills"])
    return result


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract raw text from a PDF file's bytes using PyMuPDF."""
    text_parts = []
    with fitz.open(stream=file_bytes, filetype="pdf") as doc:
        for page in doc:
            text_parts.append(page.get_text())
    return "\n".join(text_parts)


@app.post("/upload")
async def upload_cv(file: UploadFile = File(...)):
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_bytes = await file.read()

    try:
        extracted_text = extract_text_from_pdf(file_bytes)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {exc}")

    try:
        parsed = await asyncio.wait_for(
            asyncio.to_thread(parse_resume_with_llm, extracted_text),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        parsed = _fallback_result("Server timed out waiting for AI to respond")

    return {
        "id": str(uuid.uuid4()),
        "filename": file.filename,
        "status": "success",
        "data": parsed,
    }


@app.get("/")
async def health_check():
    return {"status": "ok"}