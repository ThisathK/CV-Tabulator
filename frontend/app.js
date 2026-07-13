const API_URL = "http://localhost:8000";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const tableBody = document.getElementById("table-body");
const emptyRow = document.getElementById("empty-row");
const downloadBtn = document.getElementById("download-csv");

// rowId -> candidate data (only successfully parsed rows are stored here)
const candidates = new Map();

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
    <td class="px-6 py-4 font-medium text-slate-700" colspan="6">
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
    <td class="px-6 py-4 font-medium text-slate-900">${escapeHtml(data.name)}</td>
    <td class="px-6 py-4 text-slate-600">${escapeHtml(data.email)}</td>
    <td class="px-6 py-4 text-slate-600">${escapeHtml(data.phone)}</td>
    <td class="px-6 py-4 text-slate-600">${escapeHtml(String(data.experience_years))}</td>
    <td class="px-6 py-4 text-slate-600">${escapeHtml(data.top_skills)}</td>
    <td class="px-6 py-4 text-slate-600">${escapeHtml(data.highest_education)}</td>
  `;
}

function renderErrorRow(rowId, filename, message) {
  const tr = document.getElementById(rowId);
  if (!tr) return;

  tr.innerHTML = `
    <td class="px-6 py-4 text-red-600" colspan="6">
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
    candidates.set(rowId, result.data);
    renderSuccessRow(rowId, result.data);
    updateDownloadButtonState();
  } catch (err) {
    renderErrorRow(rowId, file.name, err.message);
  }
}

function candidatesToCsv() {
  const headers = ["Name", "Email", "Phone", "Experience (Years)", "Top Skills", "Education"];
  const rows = Array.from(candidates.values()).map((c) => [
    c.name,
    c.email,
    c.phone,
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
