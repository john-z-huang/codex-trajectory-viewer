import { useEffect, useState } from "react";

export function useSessionDetail(sessionId, refreshVersion) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError("");
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`会话读取失败（${response.status}）`);
        return response.json();
      })
      .then((value) => {
        if (!ignore) {
          setDetail(value);
          setError("");
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!ignore) {
          setError(reason.message);
          setLoading(false);
        }
      });
    return () => { ignore = true; };
  }, [sessionId, refreshVersion]);

  async function loadHistoryPage(page) {
    if (!detail || page < 1) return;
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?historyPage=${page}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`SQLite 历史读取失败（${response.status}）`);
      const value = await response.json();
      setDetail((current) => current ? { ...current, supplement: value.supplement } : current);
      setError("");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setHistoryLoading(false);
    }
  }

  return { detail, loading, error, historyLoading, loadHistoryPage };
}
