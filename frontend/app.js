// Local dev hits the local backend automatically; anywhere else, use the
// deployed Render backend.
const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_URL = isLocalhost
  ? "http://localhost:8000"
  : "https://cv-tabulator.onrender.com";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const tableBody = document.getElementById("table-body");
const emptyRow = document.getElementById("empty-row");
const downloadBtn = document.getElementById("download-csv");
const clearAllBtn = document.getElementById("clear-all-btn");

const cvModal = document.getElementById("cv-modal");
const cvModalFrame = document.getElementById("cv-modal-frame");
const cvModalTitle = document.getElementById("cv-modal-title");
const cvModalClose = document.getElementById("cv-modal-close");

// rowId -> candidate data (including cv_base64 and the backend's dbId), for
// successfully parsed/loaded rows only
const candidates = new Map();

// The blob URL currently loaded in the CV modal, so it can be revoked on close.
let activeCvObjectUrl = null;

// rowId -> pending debounce timer, for the Comments field's autosave.
const commentsDebounceTimers = new Map();

function updateDownloadButtonState() {
  downloadBtn.disabled = candidates.size === 0;
}

function ensureEmptyRowHidden() {
  if (emptyRow.parentNode) {
    emptyRow.remove();
  }
}

function showEmptyRowIfNeeded() {
  if (tableBody.children.length === 0) {
    tableBody.appendChild(emptyRow);
  }
}

function createProcessingRow(rowId, filename) {
  ensureEmptyRowHidden();

  const tr = document.createElement("tr");
  tr.id = rowId;
  tr.innerHTML = `
    <td class="px-6 py-4 font-medium text-slate-700" colspan="12">
      <div class="flex items-center gap-3">
        <svg class="h-4 w-4 animate-spin text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <span>Processing <span class="font-normal text-slate-400">${filename}</span>...</span>
      </div>
    </td>
  `;
  tableBody.appendChild(tr);
}

function renderSuccessRow(rowId, data) {
  const tr = document.getElementById(rowId);
  if (!tr) return;

  tr.innerHTML = `
    <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(data.name)}</td>
    <td class="px-4 py-3 text-slate-600">${escapeHtml(data.location)}</td>
    <td class="px-4 py-3 text-slate-600">${escapeHtml(data.position)}</td>
    <td class="px-4 py-3 text-slate-600">${escapeHtml(String(data.experience_years))}</td>
    <td class="px-4 py-3 text-slate-600">${escapeHtml(data.top_skills)}</td>
    <td class="px-4 py-3 text-slate-600">${escapeHtml(data.highest_education)}</td>
    <td class="px-4 py-3 text-center">
      <button
        type="button"
        data-action="view-cv"
        data-row-id="${rowId}"
        class="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        View CV
      </button>
    </td>
    <td class="px-4 py-3">
      <select
        data-role="wge-select"
        class="w-32 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <option value="">—</option>
        <option value="green">Green Light</option>
        <option value="yellow">Yellow Light</option>
        <option value="red">Red Light</option>
      </select>
    </td>
    <td class="px-4 py-3 text-center">
      <input
        type="checkbox"
        data-role="accept-checkbox"
        class="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
      />
    </td>
    <td class="px-4 py-3 text-center">
      <input
        type="checkbox"
        data-role="reject-checkbox"
        class="h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
      />
    </td>
    <td class="px-4 py-3">
      <input
        type="text"
        data-role="comments-input"
        placeholder="Add a note..."
        class="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    </td>
    <td class="px-4 py-3 text-center">
      <button
        type="button"
        data-action="delete-row"
        data-row-id="${rowId}"
        class="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
        aria-label="Delete candidate"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
        </svg>
      </button>
    </td>
  `;
}

// Restores WGE/Accept/Reject/Comments UI state from a saved DB row
// ({ status, light, remarks }) - used both for freshly-loaded rows and
// (harmlessly, since defaults match a blank UI) for brand-new uploads.
function applySavedState(rowId, saved) {
  const tr = document.getElementById(rowId);
  if (!tr) return;

  const wgeSelect = tr.querySelector('[data-role="wge-select"]');
  const acceptBox = tr.querySelector('[data-role="accept-checkbox"]');
  const rejectBox = tr.querySelector('[data-role="reject-checkbox"]');
  const commentsInput = tr.querySelector('[data-role="comments-input"]');

  if (wgeSelect) wgeSelect.value = saved.light || "";
  if (acceptBox) acceptBox.checked = saved.status === "Accepted";
  if (rejectBox) rejectBox.checked = saved.status === "Rejected";
  if (commentsInput) commentsInput.value = saved.remarks || "";
}

function renderErrorRow(rowId, filename, message) {
  const tr = document.getElementById(rowId);
  if (!tr) return;

  tr.innerHTML = `
    <td class="px-6 py-4 text-red-600" colspan="12">
      Failed to process <span class="font-medium">${escapeHtml(filename)}</span>: ${escapeHtml(message)}
    </td>
  `;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type === "application/pdf");
  if (files.length === 0) return;

  for (const file of files) {
    const rowId = `row-${crypto.randomUUID()}`;
    createProcessingRow(rowId, file.name);
    uploadFile(file, rowId); // fire-and-forget so rows update independently as each completes
  }
}

async function uploadFile(file, rowId) {
  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch(`${API_URL}/upload`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.detail || `Server error (${response.status})`);
    }

    const result = await response.json();
    candidates.set(rowId, {
      ...result.data,
      cv_base64: result.cv_base64,
      filename: result.filename,
      dbId: result.id,
    });
    renderSuccessRow(rowId, result.data);
    applySavedState(rowId, { status: "Pending", light: "", remarks: "" });
    updateDownloadButtonState();
  } catch (err) {
    renderErrorRow(rowId, file.name, err.message);
  }
}

// --- Loading existing candidates on page load ---

async function loadCandidates() {
  try {
    const response = await fetch(`${API_URL}/candidates`);
    if (!response.ok) return;

    const rows = await response.json();
    for (const row of rows) {
      const rowId = `row-db-${row.id}`;
      candidates.set(rowId, {
        name: row.name,
        email: row.email,
        phone: row.phone,
        location: row.location,
        position: row.position,
        experience_years: row.experience_years,
        top_skills: row.top_skills,
        highest_education: row.highest_education,
        cv_base64: row.cv_base64,
        filename: row.filename,
        dbId: row.id,
      });
      createProcessingRow(rowId, row.filename);
      renderSuccessRow(rowId, candidates.get(rowId));
      applySavedState(rowId, row);
    }
    updateDownloadButtonState();
  } catch (err) {
    console.error("Failed to load existing candidates:", err);
  }
}

// --- Auto-save (PATCH /candidates/{id}) ---

async function patchCandidate(rowId, updates) {
  const candidate = candidates.get(rowId);
  if (!candidate || candidate.dbId == null) return;

  try {
    await fetch(`${API_URL}/candidates/${candidate.dbId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  } catch (err) {
    console.error(`Failed to save update for row ${rowId}:`, err);
  }
}

function debounceSaveRemarks(rowId, value) {
  if (commentsDebounceTimers.has(rowId)) {
    clearTimeout(commentsDebounceTimers.get(rowId));
  }
  const timeoutId = setTimeout(() => {
    patchCandidate(rowId, { remarks: value });
    commentsDebounceTimers.delete(rowId);
  }, 500);
  commentsDebounceTimers.set(rowId, timeoutId);
}

// --- Deletion ---

async function deleteRow(rowId) {
  if (!confirm("Delete this candidate?")) return;

  const candidate = candidates.get(rowId);
  if (candidate && candidate.dbId != null) {
    try {
      await fetch(`${API_URL}/candidates/${candidate.dbId}`, { method: "DELETE" });
    } catch (err) {
      console.error("Failed to delete candidate on server:", err);
    }
  }

  candidates.delete(rowId);
  const tr = document.getElementById(rowId);
  if (tr) tr.remove();
  updateDownloadButtonState();
  showEmptyRowIfNeeded();
}

async function clearAllCandidates() {
  if (!confirm("Are you sure? This cannot be undone.")) return;

  try {
    await fetch(`${API_URL}/candidates`, { method: "DELETE" });
  } catch (err) {
    console.error("Failed to clear candidates on server:", err);
  }

  candidates.clear();
  tableBody.innerHTML = "";
  showEmptyRowIfNeeded();
  updateDownloadButtonState();
}

function candidatesToCsv() {
  const headers = [
    "Name", "Email", "Phone", "Location", "Position", "Experience (Years)",
    "Top Skills", "Education", "WGE", "Accept", "Reject", "Comments",
  ];
  const rows = Array.from(candidates.entries()).map(([rowId, c]) => {
    const tr = document.getElementById(rowId);
    const wgeSelect = tr ? tr.querySelector('[data-role="wge-select"]') : null;
    const acceptBox = tr ? tr.querySelector('[data-role="accept-checkbox"]') : null;
    const rejectBox = tr ? tr.querySelector('[data-role="reject-checkbox"]') : null;
    const commentsInput = tr ? tr.querySelector('[data-role="comments-input"]') : null;

    const wge = wgeSelect && wgeSelect.selectedOptions.length
      ? wgeSelect.selectedOptions[0].textContent
      : "";
    const accept = acceptBox && acceptBox.checked ? "Yes" : "No";
    const reject = rejectBox && rejectBox.checked ? "Yes" : "No";
    const comments = commentsInput ? commentsInput.value : "";

    return [
      c.name,
      c.email,
      c.phone,
      c.location,
      c.position,
      c.experience_years,
      c.top_skills,
      c.highest_education,
      wge,
      accept,
      reject,
      comments,
    ];
  });

  const escapeCsvField = (field) => {
    const str = String(field ?? "");
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(","));
  return lines.join("\n");
}

function downloadCsv() {
  const csv = candidatesToCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "candidates.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- CV preview modal ---

function base64ToBlobUrl(base64Data, mimeType) {
  const byteChars = atob(base64Data);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
  return URL.createObjectURL(blob);
}

function openCvModal(rowId) {
  const candidate = candidates.get(rowId);
  if (!candidate || !candidate.cv_base64) return;

  const objectUrl = base64ToBlobUrl(candidate.cv_base64, "application/pdf");
  activeCvObjectUrl = objectUrl;

  cvModalTitle.textContent = candidate.filename ? `CV Preview — ${candidate.filename}` : "CV Preview";
  cvModalFrame.src = objectUrl;
  cvModal.classList.remove("hidden");
  cvModal.classList.add("flex");
}

function closeCvModal() {
  cvModal.classList.add("hidden");
  cvModal.classList.remove("flex");
  cvModalFrame.src = "";
  if (activeCvObjectUrl) {
    URL.revokeObjectURL(activeCvObjectUrl);
    activeCvObjectUrl = null;
  }
}

// --- Event wiring ---

dropZone.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  fileInput.value = ""; // allow re-uploading the same file later
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("border-indigo-400", "bg-indigo-50/40");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("border-indigo-400", "bg-indigo-50/40");
  });
});

dropZone.addEventListener("drop", (e) => {
  handleFiles(e.dataTransfer.files);
});

downloadBtn.addEventListener("click", downloadCsv);
clearAllBtn.addEventListener("click", clearAllCandidates);

// Delegated click handling for dynamically-created "View CV" / "Delete" buttons.
tableBody.addEventListener("click", (e) => {
  const viewCvBtn = e.target.closest('[data-action="view-cv"]');
  if (viewCvBtn) {
    openCvModal(viewCvBtn.dataset.rowId);
    return;
  }

  const deleteBtn = e.target.closest('[data-action="delete-row"]');
  if (deleteBtn) {
    deleteRow(deleteBtn.dataset.rowId);
  }
});

// Delegated change handling: keep Accept/Reject checkboxes mutually exclusive
// per row, and auto-save Accept/Reject/WGE changes to the backend.
tableBody.addEventListener("change", (e) => {
  const target = e.target;
  const row = target.closest("tr");
  if (!row) return;

  if (target.matches('[data-role="accept-checkbox"]') && target.checked) {
    const rejectBox = row.querySelector('[data-role="reject-checkbox"]');
    if (rejectBox) rejectBox.checked = false;
  }

  if (target.matches('[data-role="reject-checkbox"]') && target.checked) {
    const acceptBox = row.querySelector('[data-role="accept-checkbox"]');
    if (acceptBox) acceptBox.checked = false;
  }

  if (target.matches('[data-role="accept-checkbox"], [data-role="reject-checkbox"]')) {
    const acceptBox = row.querySelector('[data-role="accept-checkbox"]');
    const rejectBox = row.querySelector('[data-role="reject-checkbox"]');
    const status = acceptBox.checked ? "Accepted" : rejectBox.checked ? "Rejected" : "Pending";
    patchCandidate(row.id, { status });
  }

  if (target.matches('[data-role="wge-select"]')) {
    patchCandidate(row.id, { light: target.value });
  }
});

// Debounced auto-save for the Comments field, so we don't PATCH on every keystroke.
tableBody.addEventListener("input", (e) => {
  if (e.target.matches('[data-role="comments-input"]')) {
    const row = e.target.closest("tr");
    if (row) debounceSaveRemarks(row.id, e.target.value);
  }
});

cvModalClose.addEventListener("click", closeCvModal);

// Click on the backdrop (not the inner panel) closes the modal.
cvModal.addEventListener("click", (e) => {
  if (e.target === cvModal) closeCvModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !cvModal.classList.contains("hidden")) {
    closeCvModal();
  }
});

loadCandidates();
