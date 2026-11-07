/** A copy of `source` that only updates once it has been still for `ms` (for search-as-you-type). */
export function useDebounced<T>(source: Ref<T>, ms = 250): Ref<T> {
  const out = ref(source.value) as Ref<T>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(source, (v) => {
    clearTimeout(timer);
    timer = setTimeout(() => (out.value = v), ms);
  });
  onScopeDispose(() => clearTimeout(timer));
  return out;
}
