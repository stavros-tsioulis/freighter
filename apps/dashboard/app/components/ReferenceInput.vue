<script setup lang="ts">
import { referenceAt, suggest, type Suggestion } from "~/utils/references";

/** A text input for an environment value. Typing `@` lists what it can connect to, filtered by what follows. */
const props = defineProps<{ app: string; ownServices?: string[]; ownVolumes?: string[]; /** The other variables of the service this value belongs to, for `@self.NAME`. */ ownEnv?: string[]; id?: string; placeholder?: string; ariaLabel?: string; /** Only the public addresses of services (`domain`, `url`): what a build can read. */ publicOnly?: boolean }>();
const model = defineModel<string>({ required: true });

const sources = useReferenceSources(computed(() => props.app), computed(() => props.ownServices), computed(() => props.ownVolumes));
const input = ref<{ $el: HTMLInputElement } | null>(null);
const el = () => input.value?.$el;

const open = ref(false);
const start = ref(0);
const braced = ref(false);
const caret = ref(0);
const items = ref<Suggestion[]>([]);
const active = ref(0);
const pos = ref({ left: 0, top: 0, width: 0 });
const listId = `ref-${useId()}`;

function refresh() {
  const e = el();
  if (!e) return;
  caret.value = e.selectionStart ?? model.value.length;
  const at = referenceAt(model.value, caret.value);
  const found = at ? suggest(at.query, sources.value, { publicOnly: props.publicOnly, self: props.ownEnv }) : [];
  if (!at || !found.length) {
    open.value = false;
    return;
  }
  start.value = at.start;
  braced.value = at.braced;
  items.value = found;
  active.value = Math.min(active.value, found.length - 1);
  const r = e.getBoundingClientRect();
  pos.value = { left: r.left, top: r.bottom + 4, width: Math.max(r.width, 280) };
  open.value = true;
}

async function choose(s: Suggestion) {
  const close = braced.value && !s.more && model.value[caret.value] !== "}" ? "}" : "";
  model.value = model.value.slice(0, start.value) + s.insert + close + model.value.slice(caret.value);
  active.value = 0;
  await nextTick();
  const end = start.value + s.insert.length + close.length;
  el()?.setSelectionRange(end, end);
  if (s.more) refresh();
  else open.value = false;
}

function onKey(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active.value = (active.value + (e.key === "ArrowDown" ? 1 : -1) + items.value.length) % items.value.length;
    document.getElementById(`${listId}-${active.value}`)?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    void choose(items.value[active.value]!);
  } else if (e.key === "Escape") {
    e.stopPropagation(); // not the dialog's close
    open.value = false;
  }
}

// ArrowUp/Down move inside the list, so only the other keys re-read the cursor.
const onKeyup = (e: KeyboardEvent) => {
  if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) refresh();
};
const close = () => (open.value = false);
onMounted(() => window.addEventListener("scroll", close, true));
onBeforeUnmount(() => window.removeEventListener("scroll", close, true));
</script>

<template>
  <InputText
    :id="id"
    ref="input"
    v-model="model"
    class="font-mono w-full"
    autocomplete="off"
    spellcheck="false"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    role="combobox"
    aria-autocomplete="list"
    :aria-expanded="open"
    :aria-controls="open ? listId : undefined"
    :aria-activedescendant="open ? `${listId}-${active}` : undefined"
    @input="refresh"
    @click="refresh"
    @keydown="onKey"
    @keyup="onKeyup"
    @blur="close"
  />
  <Teleport to="body">
    <ul v-if="open" :id="listId" role="listbox" class="ref-list" :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` }">
      <li
        v-for="(s, i) in items"
        :id="`${listId}-${i}`"
        :key="s.insert"
        role="option"
        :aria-selected="i === active"
        class="ref-item"
        :data-active="i === active ? '' : undefined"
        @mousedown.prevent="choose(s)"
        @mousemove="active = i"
      >
        <code>{{ s.label }}</code>
        <span>{{ s.detail }}</span>
      </li>
    </ul>
  </Teleport>
</template>

<style>
.ref-list {
  position: fixed;
  z-index: 10000;
  max-height: 14rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--p-content-background, var(--fr-panel));
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-lg, 0.5rem);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.15);
}
.ref-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.35rem 0.6rem;
  border-radius: var(--p-border-radius-md, 0.375rem);
  cursor: pointer;
}
.ref-item span { font-size: 0.8rem; color: var(--p-text-muted-color); text-align: right; }
.ref-item[data-active] { background: var(--p-highlight-background, rgb(0 0 0 / 0.06)); }
</style>
