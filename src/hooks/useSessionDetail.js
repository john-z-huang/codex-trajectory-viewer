import { useEffect, useRef, useState } from "react";

export function useSessionDetail(sessionId, refreshVersion) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const hasDetail = Boolean(detail);
  const generationRef = useRef(0);
  const historyRequestRef = useRef(0);
  const detailControllerRef = useRef(null);
  const historyControllerRef = useRef(null);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    historyRequestRef.current += 1;
    detailControllerRef.current?.abort();
    historyControllerRef.current?.abort();
    historyControllerRef.current = null;
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setLoading(true);
    setError("");
    setHistoryLoading(false);
    const staleResponse = {};
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (generationRef.current !== generation) return staleResponse;
        if (!response.ok) throw new Error(`会话读取失败（${response.status}）`);
        return response.json();
      })
      .then((value) => {
        if (value !== staleResponse && generationRef.current === generation) {
          setDetail(value);
          setError("");
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (generationRef.current === generation && reason?.name !== "AbortError") {
          setError(reason?.message || "会话读取失败");
          setLoading(false);
        }
      })
      .finally(() => {
        if (detailControllerRef.current === controller) detailControllerRef.current = null;
      });
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      controller.abort();
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
      historyRequestRef.current += 1;
      historyControllerRef.current?.abort();
      historyControllerRef.current = null;
    };
  }, [sessionId, refreshVersion]);

  async function loadHistoryPage(page) {
    if (!hasDetail || page < 1) return;
    historyControllerRef.current?.abort();
    const controller = new AbortController();
    historyControllerRef.current = controller;
    const generation = generationRef.current;
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    const isCurrent = () => generationRef.current === generation && historyRequestRef.current === request;
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?historyPage=${page}`, { cache: "no-store", signal: controller.signal });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(`SQLite 历史读取失败（${response.status}）`);
      const value = await response.json();
      if (!isCurrent()) return;
      setDetail((current) => isCurrent() && current ? { ...current, supplement: value.supplement } : current);
      setError("");
    } catch (reason) {
      if (isCurrent() && reason?.name !== "AbortError") setError(reason?.message || "SQLite 历史读取失败");
    } finally {
      if (isCurrent()) {
        setHistoryLoading(false);
        if (historyControllerRef.current === controller) historyControllerRef.current = null;
      }
    }
  }

  return { detail, loading, error, historyLoading, loadHistoryPage };
}
