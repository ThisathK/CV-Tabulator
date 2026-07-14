import asyncio
import base64
import logging
import os
import re
import uuid
from typing import List

import certifi

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["SSL_CERT_DIR"] = os.path.dirname(certifi.where())

import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

load_dotenv()  # reads GEMINI_API_KEY from a local .env file

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cv_tabulator")

app = FastAPI(title="CV Tabulator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# gemini-2.0-flash was requested but is now fully retired on this account
# (verified live: 404 "no longer available", not just a quota limit).
# gemini-2.5-flash and gemini-1.5-flash are also confirmed dead. Substituted
# the closest available lightweight equivalent, gemini-flash-lite-latest -
# re-check ListModels before changing this again.
GEMINI_MODEL = "gemini-flash-lite-latest"
GEMINI_TIMEOUT_MS = 40_000
REQUEST_TIMEOUT_SECONDS = 45
MAX_RESUME_TEXT_CHARS = 15_000

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
- "location" (string, the candidate's address or city, empty string if not present)
- "position" (string, the specific job title/role applied for, or their current
  most prominent role if no target role is stated)
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
    location: str
    position: str
    experience_years: int
    top_skills: List[str]
    highest_education: str


class UpstreamAPIError(Exception):
    """The Gemini API call itself failed (network, auth, quota, overload, ...)."""


class UnparseableResponseError(Exception):
    """Gemini responded, but the text wasn't valid JSON matching ResumeData."""


def sanitize_text(text: str) -> str:
    """Collapse whitespace and cap length before sending resume text to the LLM."""
    collapsed = re.sub(r"\s+", " ", text).strip()
    return collapsed[:MAX_RESUME_TEXT_CHARS]


def parse_resume_with_llm(extracted_text: str) -> dict:
    """
    Sends the extracted resume text to the Gemini API and returns structured
    candidate data matching our table schema. Raises UpstreamAPIError /
    UnparseableResponseError on failure - the caller maps these to proper
    HTTP status codes instead of masking them behind a 200 response.
    """
    if gemini_client is None:
        raise UpstreamAPIError("GEMINI_API_KEY is not configured on the server")

    logger.info(
        "Calling Gemini model=%s (%d chars of resume text)",
        GEMINI_MODEL,
        len(extracted_text),
    )
    try:
        response = gemini_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=f"Resume text:\n\n{extracted_text}",
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                # Soft parsing (JSON mime type, no response_schema): schema-
                # constrained decoding was measured to trigger far more
                # frequent/longer 503 "high demand" retries on this tier, so
                # we validate the plain JSON text against ResumeData ourselves.
                response_mime_type="application/json",
                temperature=0,
                http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS),
            ),
        )
    except genai_errors.APIError as exc:
        logger.error("Gemini API error: %s", exc, exc_info=True)
        raise UpstreamAPIError(str(exc)) from exc
    except Exception as exc:
        logger.error("Gemini request failed unexpectedly: %s", exc, exc_info=True)
        raise UpstreamAPIError(str(exc)) from exc

    logger.info("Gemini call succeeded, validating JSON response")

    try:
        raw_text = response.text.strip()
        cleaned_text = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.IGNORECASE)
        cleaned_text = re.sub(r"\s*```$", "", cleaned_text)
        parsed = ResumeData.model_validate_json(cleaned_text)
    except Exception as exc:
        logger.error(
            "Gemini response failed JSON/schema validation: %s", exc, exc_info=True
        )
        raise UnparseableResponseError(str(exc)) from exc

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

    logger.info("Extracting text from %s (%d bytes)", file.filename, len(file_bytes))
    try:
        # PyMuPDF is synchronous/CPU-bound; run it off the event loop so a
        # large PDF can't stall every other concurrent upload.
        extracted_text = await asyncio.to_thread(extract_text_from_pdf, file_bytes)
    except Exception as exc:
        logger.error("PDF extraction failed for %s: %s", file.filename, exc, exc_info=True)
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {exc}")

    logger.info("Extracted %d characters of text from %s", len(extracted_text), file.filename)

    if not extracted_text.strip():
        logger.error("No extractable text in %s", file.filename)
        raise HTTPException(
            status_code=422, detail="No text could be extracted from this PDF."
        )

    sanitized_text = sanitize_text(extracted_text)

    try:
        parsed = await asyncio.wait_for(
            asyncio.to_thread(parse_resume_with_llm, sanitized_text),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error(
            "Gemini did not respond within %ss for %s", REQUEST_TIMEOUT_SECONDS, file.filename
        )
        raise HTTPException(
            status_code=504,
            detail=f"Gemini API did not respond within {REQUEST_TIMEOUT_SECONDS}s.",
        )
    except UpstreamAPIError as exc:
        raise HTTPException(status_code=500, detail=f"Gemini API request failed: {exc}")
    except UnparseableResponseError as exc:
        raise HTTPException(
            status_code=500, detail=f"Gemini returned invalid/unparseable data: {exc}"
        )

    logger.info("Successfully parsed resume for %s", file.filename)

    cv_base64 = base64.b64encode(file_bytes).decode("utf-8")

    return {
        "id": str(uuid.uuid4()),
        "filename": file.filename,
        "status": "success",
        "data": parsed,
        "cv_base64": cv_base64,
    }


@app.get("/")
async def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    # Render (and most PaaS hosts) inject the port to bind via $PORT - never
    # hardcode a port for production. Falls back to 8000 for local runs.
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
