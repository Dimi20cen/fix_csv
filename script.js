/* csv.dimy.dev – frontend-only CSV cleaner
 *
 * - Uses PapaParse in a web worker to avoid blocking the UI.
 * - Reads the file as ArrayBuffer, then tries multiple encodings to minimize �.
 * - Cleans data according to toggleable options.
 * - Provides first-50-rows preview and downloadable cleaned CSV.
 */

(() => {
  // --- DOM references ---
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const cleanButton = document.getElementById('cleanButton');
  const downloadButton = document.getElementById('downloadButton');
  const resetOptionsButton = document.getElementById('resetOptionsButton');

  const optionTrim = document.getElementById('optionTrim');
  const optionRemoveEmpty = document.getElementById('optionRemoveEmpty');
  const optionFixColumns = document.getElementById('optionFixColumns');
  const optionDeduplicate = document.getElementById('optionDeduplicate');
  const optionNormalizeHeader = document.getElementById('optionNormalizeHeader');
  const optionNormalizeFormat = document.getElementById('optionNormalizeFormat');
  const optionConsistentQuotes = document.getElementById('optionConsistentQuotes');
  const optionEncodingFix = document.getElementById('optionEncodingFix');

  const previewHead = document.getElementById('previewHead');
  const previewBody = document.getElementById('previewBody');
  const previewMeta = document.getElementById('previewMeta');

  const errorBox = document.getElementById('errorBox');
  const statusBox = document.getElementById('statusBox');
  const statusText = document.getElementById('statusText');
  const statsBox = document.getElementById('statsBox');

  // --- State ---
  const state = {
    file: null,
    encodingUsed: 'utf-8',
    encodingHasIssues: false,
    originalData: null,
    cleanedData: null,
    parseMeta: null,
    rowsBefore: 0,
    rowsAfter: 0,
    lastStats: null,
  };

  // --- Helpers: UI ---

  function setStatus(message, tone = 'info') {
    statusText.textContent = message;

    // tone = 'info' | 'success' | 'warning'
    const base =
      'rounded-xl border text-xs p-3 flex items-start gap-2 transition-colors duration-150';
    if (tone === 'success') {
      statusBox.className =
        base +
        ' border-emerald-500/40 bg-emerald-950/50 text-emerald-100';
    } else if (tone === 'warning') {
      statusBox.className =
        base + ' border-amber-500/40 bg-amber-950/50 text-amber-100';
    } else {
      statusBox.className =
        base + ' border-emerald-500/30 bg-emerald-950/40 text-emerald-100';
    }
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
  }

  function setLoading(isLoading, messageIfLoading) {
    if (isLoading) {
      cleanButton.disabled = true;
      downloadButton.disabled = true;
      setStatus(messageIfLoading || 'Working...', 'info');
    } else {
      if (state.originalData) cleanButton.disabled = false;
      if (state.cleanedData) downloadButton.disabled = false;

      if (!state.file) {
        setStatus('Waiting for file upload.', 'info');
      } else if (state.cleanedData) {
        setStatus('Cleaning complete. You can download the cleaned CSV.', 'success');
      } else {
        setStatus('CSV loaded. Adjust options and click “Clean CSV”.', 'info');
      }
    }
  }

  function resetStats() {
    state.rowsBefore = 0;
    state.rowsAfter = 0;
    state.lastStats = null;
    statsBox.classList.add('hidden');
    statsBox.textContent = '';
  }

  function renderStats() {
    if (!state.lastStats) {
      statsBox.classList.add('hidden');
      return;
    }

    const s = state.lastStats;
    statsBox.innerHTML = `
      <div class="space-y-1">
        <div class="font-semibold text-[11px] uppercase tracking-wide text-slate-300">
          Cleaning summary
        </div>
        <div>
          <span class="font-mono">Rows:</span>
          ${state.rowsBefore} → <span class="font-mono">${state.rowsAfter}</span>
        </div>
        <div class="grid grid-cols-2 gap-1 mt-1">
          <div>Empty rows removed: <span class="font-mono">${s.removedEmpty}</span></div>
          <div>Duplicates removed: <span class="font-mono">${s.duplicatesRemoved}</span></div>
          <div>Rows trimmed (extra columns): <span class="font-mono">${s.trimmedColumns}</span></div>
          <div>Rows padded (missing columns): <span class="font-mono">${s.paddedColumns}</span></div>
        </div>
      </div>
    `;
    statsBox.classList.remove('hidden');
  }

  function resetOptionsToDefaults() {
    optionTrim.checked = true;
    optionRemoveEmpty.checked = true;
    optionFixColumns.checked = true;
    optionDeduplicate.checked = false;
    optionNormalizeHeader.checked = true;
    optionNormalizeFormat.checked = true;
    optionConsistentQuotes.checked = true;
    optionEncodingFix.checked = true;
  }

  // --- Helpers: encoding / reading ---

  /**
   * Read file as ArrayBuffer, try multiple encodings and pick the one
   * with the fewest replacement characters (�).
   */
  function readFileWithBestEncoding(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        try {
          const buffer = reader.result;

          // Fallback if TextDecoder is not available
          if (typeof TextDecoder === 'undefined') {
            const textReader = new FileReader();
            textReader.onerror = () => reject(textReader.error);
            textReader.onload = () =>
              resolve({
                text: textReader.result,
                encoding: 'utf-8',
                replacementCount: 0,
              });
            textReader.readAsText(file);
            return;
          }

          const encodingsToTry = ['utf-8', 'windows-1252', 'iso-8859-1'];
          let best = {
            text: '',
            encoding: 'utf-8',
            replacementCount: Number.POSITIVE_INFINITY,
          };

          encodingsToTry.forEach((enc) => {
            try {
              const decoder = new TextDecoder(enc, { fatal: false });
              const text = decoder.decode(buffer);
              const replacementCount = (text.match(/\uFFFD/g) || []).length;
              if (replacementCount < best.replacementCount) {
                best = { text, encoding: enc, replacementCount };
              }
            } catch {
              // ignore unsupported encoding
            }
          });

          if (!best.text) {
            const decoder = new TextDecoder();
            best.text = decoder.decode(buffer);
            best.encoding = 'utf-8';
            best.replacementCount =
              (best.text.match(/\uFFFD/g) || []).length;
          }

          // Strip BOM from the beginning, if present
          if (best.text.charCodeAt(0) === 0xfeff) {
            best.text = best.text.slice(1);
          }

          resolve(best);
        } catch (err) {
          reject(err);
        }
      };

      reader.readAsArrayBuffer(file);
    });
  }

  // --- Helpers: CSV parsing & preview ---

  function parseCsvText(text) {
    return new Promise((resolve, reject) => {
      Papa.parse(text, {
        delimiter: '', // let Papa auto-detect (comma, semicolon, tab, etc.)
        newline: '', // auto-detect line endings
        skipEmptyLines: false,
        worker: true, // parse in a web worker to keep UI responsive
        error: (err) => {
          reject(err || new Error('Unknown parsing error.'));
        },
        complete: (result) => {
          if (!result || !Array.isArray(result.data) || !result.data.length) {
            reject(new Error('Parsed CSV is empty or invalid.'));
            return;
          }
          resolve(result);
        },
      });
    });
  }

  function safeCellText(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function updatePreviewTable(data) {
    previewHead.innerHTML = '';
    previewBody.innerHTML = '';

    if (!data || !data.length) {
      previewMeta.textContent = 'No data to preview.';
      return;
    }

    const maxRows = Math.min(50, data.length);
    const headerRow = data[0] || [];
    const colCount = headerRow.length;

    // Header
    for (let c = 0; c < colCount; c += 1) {
      const th = document.createElement('th');
      th.className =
        'px-3 py-2 text-[11px] font-semibold text-slate-200 border-b border-slate-800 sticky top-0 bg-slate-900';
      let text = safeCellText(headerRow[c]);
      if (text.length > 40) text = text.slice(0, 37) + '…';
      th.textContent = text || `(col ${c + 1})`;
      previewHead.appendChild(th);
    }

    // Body
    for (let r = 1; r < maxRows; r += 1) {
      const row = data[r] || [];
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-900/70';

      for (let c = 0; c < colCount; c += 1) {
        const td = document.createElement('td');
        td.className = 'px-3 py-1.5 text-[11px] text-slate-200 whitespace-nowrap';
        let text = safeCellText(row[c]);
        if (text.length > 60) text = text.slice(0, 57) + '…';
        td.textContent = text;
        tr.appendChild(td);
      }

      previewBody.appendChild(tr);
    }

    const hiddenRows = data.length - maxRows;
    previewMeta.textContent =
      data.length <= maxRows
        ? `Showing ${data.length} row(s).`
        : `Showing ${maxRows} of ${data.length} rows (first 50).`;
    if (hiddenRows > 0) {
      previewMeta.textContent += ` ${hiddenRows} row(s) hidden in preview.`;
    }
  }

  // --- Cleaning logic ---

  function normalizeHeaderValue(value) {
    const raw = safeCellText(value).trim().toLowerCase();
    if (!raw) return '';
    return raw
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function cleanData() {
    if (!state.originalData || !state.originalData.length) {
      throw new Error('No CSV data to clean.');
    }

    const options = {
      trim: optionTrim.checked,
      removeEmpty: optionRemoveEmpty.checked,
      fixColumns: optionFixColumns.checked,
      dedupe: optionDeduplicate.checked,
      normalizeHeader: optionNormalizeHeader.checked,
    };

    const stats = {
      removedEmpty: 0,
      duplicatesRemoved: 0,
      trimmedColumns: 0,
      paddedColumns: 0,
    };

    // Clone the data to avoid mutating the original array
    const data = state.originalData.map((row) => [...row]);

    // Step 1: Remove BOM from first cell if still present
    if (data[0] && typeof data[0][0] === 'string') {
      data[0][0] = data[0][0].replace(/^\uFEFF/, '');
    }

    // Step 2: Trim cells, normalize line endings inside cells, and optionally drop empty rows
    const cleanedRows = [];

    for (let i = 0; i < data.length; i += 1) {
      const row = data[i];
      if (!Array.isArray(row)) continue;

      const newRow = row.map((cell) => {
        let value = safeCellText(cell);

        // Normalize line endings inside cells to \n
        value = value.replace(/\r\n|\r/g, '\n');

        if (options.trim) {
          value = value.trim();
        }

        return value;
      });

      const isEmptyRow = newRow.every((cell) => safeCellText(cell).trim() === '');

      if (options.removeEmpty && isEmptyRow) {
        stats.removedEmpty += 1;
        continue;
      }

      cleanedRows.push(newRow);
    }

    if (!cleanedRows.length) {
      throw new Error('All rows were removed during cleaning. Check your options.');
    }

    // Step 3: Fix inconsistent column counts relative to header row
    let finalRows = cleanedRows;
    if (options.fixColumns) {
      const expectedCols = cleanedRows[0].length;
      finalRows = [];

      for (let i = 0; i < cleanedRows.length; i += 1) {
        const row = cleanedRows[i];
        const diff = row.length - expectedCols;

        if (diff === 0) {
          finalRows.push(row);
        } else if (diff > 0) {
          // More columns than expected: trim extra
          finalRows.push(row.slice(0, expectedCols));
          stats.trimmedColumns += 1;
        } else {
          // Fewer columns than expected: pad with empty strings
          const padded = row.concat(new Array(Math.abs(diff)).fill(''));
          finalRows.push(padded);
          stats.paddedColumns += 1;
        }
      }
    }

    // Step 4: Normalize header row
    if (options.normalizeHeader) {
      const header = finalRows[0];
      finalRows[0] = header.map((cell) => normalizeHeaderValue(cell));
    }

    // Step 5: Deduplicate rows (excluding header)
    if (options.dedupe) {
      const seen = new Set();
      const deduped = [];
      const headerKey = finalRows[0].join('\u0001');
      seen.add(headerKey);
      deduped.push(finalRows[0]);

      for (let i = 1; i < finalRows.length; i += 1) {
        const key = finalRows[i].join('\u0001');
        if (seen.has(key)) {
          stats.duplicatesRemoved += 1;
        } else {
          seen.add(key);
          deduped.push(finalRows[i]);
        }
      }

      finalRows = deduped;
    }

    state.cleanedData = finalRows;
    state.rowsAfter = finalRows.length;
    state.lastStats = stats;
  }

  // --- Download ---

  function downloadCleanedCsv() {
    if (!state.cleanedData || !state.cleanedData.length) {
      showError('Nothing to download. Clean a CSV first.');
      return;
    }
    if (!state.file) {
      showError('Original file information is missing.');
      return;
    }

    const useQuotes = optionConsistentQuotes.checked;
    const normalizeFormat = optionNormalizeFormat.checked;
    const encodingFix = optionEncodingFix.checked;

    // Build CSV string
    let csvString = Papa.unparse(state.cleanedData, {
      delimiter: ',', // normalized delimiter
      newline: '\r\n', // normalized line endings (Windows-friendly)
      quotes: useQuotes,
      quoteChar: '"',
      escapeChar: '"',
      header: false,
    });

    if (normalizeFormat) {
      csvString = csvString.replace(/\r\n|\r|\n/g, '\r\n');
    }

    const blobParts = [];
    if (encodingFix) {
      // Add BOM to help Excel & friends interpret UTF-8 correctly
      blobParts.push('\uFEFF');
    }
    blobParts.push(csvString);

    const blob = new Blob(blobParts, {
      type: 'text/csv;charset=utf-8;',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    const originalName = state.file.name.replace(/\.[^/.]+$/, '');
    const filename = `cleaned_${originalName}.csv`;

    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  // --- Event handlers ---

  async function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    clearError();
    resetStats();
    state.originalData = null;
    state.cleanedData = null;
    previewHead.innerHTML = '';
    previewBody.innerHTML = '';
    previewMeta.textContent = 'No data loaded.';
    cleanButton.disabled = true;
    downloadButton.disabled = true;

    if (!file) {
      state.file = null;
      fileInfo.textContent = 'No file selected.';
      setStatus('Waiting for file upload.', 'info');
      return;
    }

    state.file = file;
    const sizeKB = (file.size / 1024).toFixed(1);
    const sizeMB = file.size / (1024 * 1024);

    if (sizeMB > 20) {
      showError(
        'This file is quite large. Files above ~20MB may be slow or fail in the browser.'
      );
    }

    setLoading(true, 'Reading file & detecting encoding…');

    try {
      const { text, encoding, replacementCount } =
        await readFileWithBestEncoding(file);

      state.encodingUsed = encoding || 'utf-8';
      state.encodingHasIssues = replacementCount > 0;

      let infoText = `${file.name} • ${sizeKB} KB • decoded as ${state.encodingUsed.toUpperCase()}`;
      if (replacementCount > 0) {
        infoText += ` • possible encoding issues (${replacementCount} invalid character(s))`;
      }
      fileInfo.textContent = infoText;

      setStatus('Parsing CSV (in a web worker)…', 'info');

      const result = await parseCsvText(text);
      state.originalData = result.data;
      state.parseMeta = result.meta;
      state.rowsBefore = result.data.length;

      const colCount =
        (result.meta && result.meta.fields && result.meta.fields.length) ||
        (result.data[0] ? result.data[0].length : 0);
      const delimiter = (result.meta && result.meta.delimiter) || ',';

      updatePreviewTable(state.originalData);

      previewMeta.textContent += ` Detected delimiter "${delimiter}". Columns: ${colCount}.`;
      cleanButton.disabled = false;

      if (state.encodingHasIssues) {
        setStatus(
          `CSV parsed. We detected possible encoding issues; data has been decoded as ${state.encodingUsed.toUpperCase()}.`,
          'warning'
        );
      } else {
        setStatus('CSV parsed successfully. Ready to clean.', 'success');
      }
    } catch (err) {
      console.error(err);
      showError(err && err.message ? err.message : 'Failed to read/parse CSV file.');
      setStatus('Could not parse CSV. Please check the file and try again.', 'warning');
    } finally {
      setLoading(false);
    }
  }

  function handleCleanClick() {
    clearError();

    if (!state.originalData) {
      showError('Please upload a CSV file first.');
      return;
    }

    setLoading(true, 'Cleaning CSV data…');

    // Defer heavy work slightly so the UI can update first
    window.setTimeout(() => {
      try {
        cleanData();
        updatePreviewTable(state.cleanedData);
        renderStats();
        setStatus(
          'Cleaning complete. Preview shows cleaned data. You can now download.',
          'success'
        );
        downloadButton.disabled = false;
      } catch (err) {
        console.error(err);
        showError(err && err.message ? err.message : 'Failed to clean CSV.');
        setStatus('Cleaning failed. Adjust options and try again.', 'warning');
      } finally {
        setLoading(false);
      }
    }, 20);
  }

  function handleDownloadClick() {
    clearError();
    try {
      downloadCleanedCsv();
    } catch (err) {
      console.error(err);
      showError(err && err.message ? err.message : 'Failed to create download.');
    }
  }

  // --- Init ---

  function init() {
    resetOptionsToDefaults();
    setStatus('Waiting for file upload.', 'info');
    fileInput.addEventListener('change', handleFileChange);
    cleanButton.addEventListener('click', handleCleanClick);
    downloadButton.addEventListener('click', handleDownloadClick);
    resetOptionsButton.addEventListener('click', () => {
      resetOptionsToDefaults();
      setStatus('Options reset to defaults.', 'info');
    });
  }

  // DOM is already parsed because script is at the end of body,
  // but this keeps it safe if moved into <head> with `defer`.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
