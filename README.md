# CV Tabulator

Upload multiple PDF resumes and get a clean, tabulated data table (Name, Email, Phone,
Experience, Top Skills, Education) with one-click CSV export.

## Project structure

```
CV website/
├── backend/
│   ├── main.py            # FastAPI server: /upload endpoint, PDF text extraction, Gemini parsing
│   ├── requirements.txt
│   ├── .env                # Your real GEMINI_API_KEY goes here (gitignored)
│   └── .env.example        # Template for the above — safe to commit
└── frontend/
    ├── index.html          # Drag-and-drop UI + results table (Tailwind via CDN)
    └── app.js              # Upload logic, real-time row updates, CSV export
```

## 1. Backend setup (FastAPI)

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### Add your Gemini API key

Get a key from [Google AI Studio](https://aistudio.google.com/apikey), then open
`backend/.env` and replace the placeholder:

```
GEMINI_API_KEY=your_gemini_api_key_here
```

`main.py` loads this automatically via `load_dotenv()` at startup — the key is never
hardcoded in source. `.env` is already listed in `backend/.gitignore` so it won't get
committed; `.env.example` is the template teammates copy from.

```bash
uvicorn main:app --reload --port 8000
```

The API will be running at `http://localhost:8000`. You can check it's alive at
`http://localhost:8000/` (should return `{"status": "ok"}`) or view interactive docs at
`http://localhost:8000/docs`.

> If `GEMINI_API_KEY` is missing or invalid, `/upload` won't crash — every row will just
> show `"Failed to parse"` values with an `error` field explaining why (see below).

## 2. Frontend setup

The frontend is static (no build step). Just serve the folder so `fetch` works properly
(opening `index.html` directly via `file://` can cause CORS/module issues in some browsers):

```bash
cd frontend
python3 -m http.server 5500
```

Then open `http://localhost:5500` in your browser.

> If you serve the frontend on a different port, that's fine — the backend already has
> permissive CORS enabled (`allow_origins=["*"]`) for local development.

## 3. Using the app

1. Drag PDF resumes onto the drop zone (or click it to browse), multiple files at once.
2. Each file immediately appears as a row with a "Processing..." spinner.
3. As each file finishes on the backend, its row updates in place with the extracted data.
4. Click **Download CSV** to export everything currently in the table.

## How it works

1. **Frontend** (`app.js`) adds a placeholder row per file the instant it's dropped, then
   POSTs each file independently to `POST /upload` as `multipart/form-data`.
2. **Backend** (`main.py`) reads the PDF bytes with **PyMuPDF (`fitz`)**, extracting raw text
   page by page.
3. That raw text is passed to `parse_resume_with_llm(extracted_text)`, which sends it to the
   **Gemini API** (`gemini-3.5-flash`) with a strict HR-extraction system prompt and a
   `response_schema` (a Pydantic model: `name`, `email`, `phone`, `experience_years`,
   `top_skills`, `highest_education`) that forces the model to return well-typed JSON —
   Gemini's structured-output mode rejects anything that doesn't match the schema shape.
4. The JSON result is sent back and the frontend finds the matching row (by a generated row
   ID) and fills it in — or shows an error if that specific upload failed, without affecting
   other rows.

### Error handling

`parse_resume_with_llm` never raises — every failure mode (missing/invalid API key, network
error, Gemini returning malformed JSON) is caught and converted into a fallback dict where
every field is the string `"Failed to parse"`, plus an `error` key with the underlying
reason. This keeps a single bad resume or API hiccup from crashing the request or leaving
the frontend table in a broken state.

## Deploying to Render

**Backend (Web Service)**

- **Root directory:** `backend`
- **Build command:** `pip install -r requirements.txt`
- **Start command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
  (`main.py` also honors `$PORT` if you ever run it as `python main.py` instead.)
- **Environment variable:** set `GEMINI_API_KEY` in the Render dashboard — never commit
  a real key to `.env` in git (`.env` is already gitignored; only `.env.example` is tracked).

**Frontend (Static Site)**

- **Root directory:** `frontend`
- **Publish directory:** `.` (it's plain static HTML/JS, no build step)
- After deploying the backend, copy its `https://….onrender.com` URL into
  `frontend/app.js`, replacing the `REPLACE-WITH-YOUR-RENDER-BACKEND-URL` placeholder.
  Local development is unaffected — `app.js` auto-detects `localhost` and keeps using
  `http://localhost:8000` there.
- Once you have a stable frontend origin, tighten `main.py`'s
  `CORSMiddleware(allow_origins=["*"])` to that exact origin instead of `*`.

**No persistent disk needed.** The app never writes to the filesystem — uploaded PDFs are
processed in memory and the original file is returned to the client as a base64 string in
the response body (`cv_base64`), not saved to disk. This means Render's free-tier ephemeral
filesystem (wiped on every restart/deploy) is not a concern here. If you later add anything
that writes to disk (caching, temp files, logs you want to keep), that data will not survive
a restart on Render's free tier — use a database or object storage (S3, Render Disks) instead.

## Notes / next steps for production

- Add file size limits and stricter MIME/extension checks on the backend.
- Consider persisting results (database) instead of keeping them only in browser memory.
- Consider capping `experience_years` extraction confidence, or surfacing the model's
  reasoning for very low-confidence resumes, if extraction accuracy becomes a concern.
