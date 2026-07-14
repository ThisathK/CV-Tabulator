const API_URL = "http://localhost:8000";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const tableBody = document.getElementById("table-body");
const emptyRow = document.getElementById("empty-row");
const downloadBtn = document.getElementById("download-csv");

const cvModal = document.getElementById("cv-modal");
const cvModalFrame = document.getElementById("cv-modal-frame");
const cvModalTitle = document.getElementById("cv-modal-title");
const cvModalClose = document.getElementById("cv-modal-close");

// rowId -> candidate data (including cv_base64), for successfully parsed rows only
const candidates = new Map();

// The blob URL currently loaded in the CV modal, so it can be revoked on close.
let activeCvObjectUrl = null;

function updateDownloadButtonState() {
  downloadBtn.disabled = candidates.size === 0;
}

function ensureEmptyRowHidden() {
  if (emptyRow.parentNode) {
    emptyRow.remove();
  }
}

function createProcessingRow(rowId, filename) {
  ensureEmptyRowHidden();

  const tr = document.createElement("tr");
  tr.id = rowId;
  tr.innerHTML = `
    <td class="px-6 py-4 font-medium text-slate-700" colspan="11">
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
  `;
}

function renderErrorRow(rowId, filename, message) {
  const tr = document.getElementById(rowId);
  if (!tr) return;

  tr.innerHTML = `
    <td class="px-6 py-4 text-red-600" colspan="11">
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
    candidates.set(rowId, { ...result.data, cv_base64: result.cv_base64, filename: result.filename });
    renderSuccessRow(rowId, result.data);
    updateDownloadButtonState();
  } catch (err) {
    renderErrorRow(rowId, file.name, err.message);
  }
}

function candidatesToCsv() {
  const headers = ["Name", "Email", "Phone", "Location", "Position", "Experience (Years)", "Top Skills", "Education"];
  const rows = Array.from(candidates.values()).map((c) => [
    c.name,
    c.email,
    c.phone,
    c.location,
    c.position,
    c.experience_years,
    c.top_skills,
    c.highest_education,
  ]);

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

// Delegated click handling for dynamically-created "View CV" buttons.
tableBody.addEventListener("click", (e) => {
  const viewCvBtn = e.target.closest('[data-action="view-cv"]');
  if (viewCvBtn) {
    openCvModal(viewCvBtn.dataset.rowId);
  }
});

// Delegated change handling: keep Accept/Reject checkboxes mutually exclusive per row.
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
