import type { Toast } from '#app/utils/toast.server';
import { useEffect, useRef } from 'react';
import { toast as showToast } from 'sonner';
import { useFetcher } from 'react-router';

export function useToast(toast?: Toast | null) {
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (toast && !shown.current.has(toast.id)) {
      shown.current.add(toast.id);
      setTimeout(() => {
        showToast[toast.type](toast.title, {
          id: toast.id,
          description: toast.description,
        });
      }, 0);
    }
  }, [toast]);
}

export function useFetcherWithToast<T>() {
  const fetcher = useFetcher<T>();

  useEffect(() => {
    if (
      fetcher.data &&
      typeof fetcher.data === 'object' &&
      'id' in fetcher.data &&
      typeof fetcher.data.id === 'string' &&
      'description' in fetcher.data &&
      typeof fetcher.data.description === 'string' &&
      'type' in fetcher.data &&
      (fetcher.data.type === 'error' ||
        fetcher.data.type === 'success' ||
        fetcher.data.type === 'warning' ||
        fetcher.data.type === 'message')
    ) {
      const toastData = fetcher.data as Toast;
      const { type, title, description, id } = toastData;

      switch (type) {
        case 'error':
          showToast.error(title, { id, description });
          break;
        case 'warning':
          showToast.warning(title, { id, description });
          break;
        case 'success':
          showToast.success(title, { id, description });
          break;
        case 'message':
        default:
          showToast.message(title, { id, description });
          break;
      }
    }
  }, [fetcher.data]);

  return fetcher;
}
