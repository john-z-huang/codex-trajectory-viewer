export async function readJson(url, { signal } = {}) {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "读取日志失败");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export function pageUrl(id, { filters = {}, target = {}, revision = "" } = {}) {
  const query = new URLSearchParams({ limit: "100" });
  for (const [key, value] of Object.entries({ ...filters, ...target, revision })) {
    if (value !== "" && value !== undefined && value !== null) query.set(key, String(value));
  }
  return "/api/logs/" + encodeURIComponent(id) + "?" + query;
}

export function downloadUrl(id, revision) {
  return "/api/logs/" + encodeURIComponent(id) + "/download?" + new URLSearchParams({ revision });
}

export function formatBytes(value) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
  return (value / (1024 * 1024)).toFixed(1) + " MiB";
}
