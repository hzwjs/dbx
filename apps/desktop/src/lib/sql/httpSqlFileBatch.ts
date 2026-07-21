import { apiUrl } from "@/lib/common/webPath";
import { isWebSqlFileBatchTerminal, type WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";

export function listenSqlFileBatch(batchId: string, handler: (snapshot: WebSqlFileBatchSnapshot) => void): () => void {
  const es = new EventSource(apiUrl(`/api/sql-file/batches/${encodeURIComponent(batchId)}/events`));
  es.onmessage = (event) => {
    const snapshot: WebSqlFileBatchSnapshot = JSON.parse(event.data);
    handler(snapshot);
    if (isWebSqlFileBatchTerminal(snapshot)) es.close();
  };
  es.onerror = () => es.close();
  return () => es.close();
}
