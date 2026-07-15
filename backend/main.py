import asyncio
import base64
import logging
import os
import re
import secrets
from typing import List, Optional

import certifi

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["SSL_CERT_DIR"] = os.path.dirname(certifi.where())

import fitz  # PyMuPDF
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel
from sqlalchemy import Column, Integer, String, Text, create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

load_dotenv()  # reads GEMINI_API_KEY (and DATABASE_URL, BASIC_AUTH_*) from .env

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cv_tabulator")

FRONTEND_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "frontend"))

app = FastAPI(title="CV Tabulator API", docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    # Kept for the legacy separately-hosted-frontend workflow; the primary
    # workflow is now this backend serving the frontend at the same origin
    # (see "/" and "/app.js" below), which is required for the browser's
    # native Basic Auth popup to appear at all - cross-origin fetch() calls
    # never trigger it, only full-page navigations do.
    allow_origins=["https://cv-tabulator-frontend.onrender.com", "http://localhost:5500"],
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


# --- Database setup -----------------------------------------------------

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./candidates.db")
if DATABASE_URL.startswith("postgres://"):
    # Render's managed Postgres add-on hands out "postgres://" URLs, but
    # SQLAlchemy 1.4+/2.0 requires the "postgresql://" scheme.
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

_engine_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class CandidateDB(Base):
    __tablename__ = "candidates"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, default="")
    name = Column(String, default="")
    email = Column(String, default="")
    phone = Column(String, default="")
    location = Column(String, default="")
    position = Column(String, default="")
    experience_years = Column(Integer, default=0)
    top_skills = Column(String, default="")
    highest_education = Column(String, default="")
    cv_base64 = Column(Text, default="")
    # Collaborative review fields, editable from the frontend after upload.
    status = Column(String, default="Pending")
    light = Column(String, default="")
    remarks = Column(Text, default="")


Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def candidate_to_dict(row: CandidateDB) -> dict:
    return {
        "id": row.id,
        "filename": row.filename,
        "name": row.name,
        "email": row.email,
        "phone": row.phone,
        "location": row.location,
        "position": row.position,
        "experience_years": row.experience_years,
        "top_skills": row.top_skills,
        "highest_education": row.highest_education,
        "cv_base64": row.cv_base64,
        "status": row.status,
        "light": row.light,
        "remarks": row.remarks,
    }


class CandidateUpdate(BaseModel):
    status: Optional[str] = None
    light: Optional[str] = None
    remarks: Optional[str] = None


# --- Basic auth -----------------------------------------------------------

security = HTTPBasic()
# Hardcoded for now, as requested - overridable via env vars whenever you're
# ready to rotate them without another code change.
BASIC_AUTH_USERNAME = os.getenv("BASIC_AUTH_USERNAME", "admin")
BASIC_AUTH_PASSWORD = os.getenv("BASIC_AUTH_PASSWORD", "password")


def verify_credentials(credentials: HTTPBasicCredentials = Depends(security)) -> str:
    correct_username = secrets.compare_digest(credentials.username, BASIC_AUTH_USERNAME)
    correct_password = secrets.compare_digest(credentials.password, BASIC_AUTH_PASSWORD)
    if not (correct_username and correct_password):
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username


# Every route on this router requires login - added in one place so no
# individual endpoint can accidentally be left unprotected.
protected = APIRouter(dependencies=[Depends(verify_credentials)])


@protected.get("/")
async def serve_frontend():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@protected.get("/app.js")
async def serve_app_js():
    return FileResponse(
        os.path.join(FRONTEND_DIR, "app.js"), media_type="application/javascript"
    )


@protected.post("/upload")
async def upload_cv(file: UploadFile = File(...), db: Session = Depends(get_db)):
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

    db_candidate = CandidateDB(
        filename=file.filename,
        name=parsed["name"],
        email=parsed["email"],
        phone=parsed["phone"],
        location=parsed["location"],
        position=parsed["position"],
        experience_years=parsed["experience_years"],
        top_skills=parsed["top_skills"],
        highest_education=parsed["highest_education"],
        cv_base64=cv_base64,
    )
    db.add(db_candidate)
    db.commit()
    db.refresh(db_candidate)

    return {
        "id": db_candidate.id,
        "filename": file.filename,
        "status": "success",
        "data": parsed,
        "cv_base64": cv_base64,
    }


@protected.get("/candidates")
async def list_candidates(db: Session = Depends(get_db)):
    rows = db.query(CandidateDB).order_by(CandidateDB.id.asc()).all()
    return [candidate_to_dict(row) for row in rows]


@protected.patch("/candidates/{candidate_id}")
async def update_candidate(
    candidate_id: int, update: CandidateUpdate, db: Session = Depends(get_db)
):
    row = db.query(CandidateDB).filter(CandidateDB.id == candidate_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found")

    if update.status is not None:
        row.status = update.status
    if update.light is not None:
        row.light = update.light
    if update.remarks is not None:
        row.remarks = update.remarks

    db.commit()
    db.refresh(row)
    return candidate_to_dict(row)


@protected.delete("/candidates/{candidate_id}")
async def delete_candidate(candidate_id: int, db: Session = Depends(get_db)):
    row = db.query(CandidateDB).filter(CandidateDB.id == candidate_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found")
    db.delete(row)
    db.commit()
    return {"status": "deleted", "id": candidate_id}


@protected.delete("/candidates")
async def delete_all_candidates(db: Session = Depends(get_db)):
    count = db.query(CandidateDB).delete()
    db.commit()
    return {"status": "deleted_all", "count": count}


app.include_router(protected)


@app.get("/healthz")
async def health_check():
    # Deliberately NOT behind auth - PaaS platforms (Render included) need an
    # unauthenticated route to confirm the service is alive.
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    # Render (and most PaaS hosts) inject the port to bind via $PORT - never
    # hardcode a port for production. Falls back to 8000 for local runs.
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
