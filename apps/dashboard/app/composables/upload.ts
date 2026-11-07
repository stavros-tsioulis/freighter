import { ApiRequestError } from "./api";

/** Upload a .tar.gz to the deployments endpoint with progress (fetch cannot report upload progress). */
export function uploadArtifact(app: string, file: File, onProgress: (fraction: number) => void, server?: string): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/apps/${encodeURIComponent(app)}/deployments${server ? `?server=${encodeURIComponent(server)}` : ""}`);
    xhr.setRequestHeader("content-type", "application/gzip");
    xhr.setRequestHeader("x-requested-with", "freighter");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiRequestError(0, "network", "network error while uploading"));
    xhr.onload = () => {
      let json: { id?: string; error?: { code?: string; message?: string } } = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status === 202 && json.id) resolve({ id: json.id });
      else reject(new ApiRequestError(xhr.status, json.error?.code ?? "error", json.error?.message ?? `upload failed (${xhr.status})`));
    };
    xhr.send(file);
  });
}
