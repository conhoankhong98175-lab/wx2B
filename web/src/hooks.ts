import { useCallback, useEffect, useRef, useState } from 'react';

export function useAsyncData<T>(loader: () => Promise<T>, key = 'default') {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  const reload = useCallback(async () => {
    void key;
    setLoading(true);
    setError('');
    try {
      setData(await loaderRef.current());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}
