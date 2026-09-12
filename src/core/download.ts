// ==========================================================================
// Browser download helper
// ==========================================================================
//
// Shared by project export, plugin `api.exportFile`, and the diagnostics
// export so object URLs are revoked consistently (an un-revoked blob URL
// pins the whole blob in memory for the lifetime of the document).

export type DownloadData = string | ArrayBuffer | Blob;

/** Default MIME for `downloadBlob` when the caller does not supply one. */
function defaultMime(data: DownloadData): string {
  if (typeof data === 'string') return 'text/plain;charset=utf-8';
  if (data instanceof Blob) return data.type || 'application/octet-stream';
  return 'application/octet-stream';
}

/**
 * Trigger a file download. No-op when there is no DOM (SSR, tests, or the
 * plugin worker sandbox) so callers do not have to guard every site.
 */
export function downloadBlob(fileName: string, data: DownloadData, mimeType?: string): void {
  if (typeof document === 'undefined') return;
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data as BlobPart], { type: mimeType ?? defaultMime(data) });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer revoking: in some browsers revoking synchronously cancels the
    // download before the browser has begun fetching the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
