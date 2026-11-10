/**
 * Guards a dialog holding unsaved input: a browser prompt on reload or tab close,
 * and a confirmation before the dialog closes. Use `request` wherever the user can dismiss it.
 */
export function useDiscardGuard(visible: Ref<boolean>, dirty: () => boolean) {
  const confirm = useConfirm();
  const active = () => visible.value && dirty();
  const onUnload = (e: BeforeUnloadEvent) => {
    if (!active()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  onMounted(() => window.addEventListener("beforeunload", onUnload));
  onBeforeUnmount(() => window.removeEventListener("beforeunload", onUnload));

  /** Close the dialog, asking first when it holds input. */
  function request(next = false) {
    if (next || !active()) {
      visible.value = next;
      return;
    }
    confirm.require({
      header: "Discard changes?",
      message: "What you entered will be lost.",
      icon: "pi pi-exclamation-triangle",
      acceptLabel: "Discard",
      acceptProps: { severity: "danger" },
      rejectProps: { severity: "secondary", text: true, label: "Keep editing" },
      accept: () => (visible.value = false),
    });
  }
  return { request };
}
