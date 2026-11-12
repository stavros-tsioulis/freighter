<script setup lang="ts">
import { filterChoices, type Choice } from "~/utils/references";

/** A text input that lists what it could be, filtered by what is typed (the same list as the connections in an environment value). */
const props = defineProps<{ choices: Choice[]; id?: string; placeholder?: string; ariaLabel?: string }>();
const model = defineModel<string>({ required: true });

const input = ref<{ $el: HTMLInputElement } | null>(null);
const open = ref(false);
const active = ref(0);
const pos = ref({ left: 0, top: 0, width: 0 });
const listId = `sg-${useId()}`;
const items = computed(() => filterChoices(props.choices, model.value));

function show() {
  const e = input.value?.$el;
  if (!e || !items.value.length) {
    open.value = false;
    return;
  }
  const r = e.getBoundingClientRect();
  pos.value = { left: r.left, top: r.bottom + 4, width: Math.max(r.width, 240) };
  active.value = Math.min(active.value, items.value.length - 1);
  open.value = true;
}
function choose(c: Choice) {
  model.value = c.value;
  open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (!open.value) {
    if (e.key === "ArrowDown") show();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active.value = (active.value + (e.key === "ArrowDown" ? 1 : -1) + items.value.length) % items.value.length;
    document.getElementById(`${listId}-${active.value}`)?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" || e.key === "Tab") {
    // Enter picks the highlighted one only while the list is open; a form is not submitted by it
    if (e.key === "Enter") e.preventDefault();
    if (items.value[active.value]) choose(items.value[active.value]!);
  } else if (e.key === "Escape") {
    e.stopPropagation(); // not the dialog's close
    open.value = false;
  }
}
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
    @focus="show"
    @click="show"
    @input="show"
    @keydown="onKey"
    @blur="close"
  />
  <Teleport to="body">
    <ul v-if="open" :id="listId" role="listbox" class="sg-list" :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` }">
      <li
        v-for="(c, i) in items"
        :id="`${listId}-${i}`"
        :key="c.value"
        role="option"
        :aria-selected="i === active"
        class="sg-item"
        :data-active="i === active ? '' : undefined"
        @mousedown.prevent="choose(c)"
        @mousemove="active = i"
      >
        <code>{{ c.value }}</code>
        <span v-if="c.detail">{{ c.detail }}</span>
      </li>
    </ul>
  </Teleport>
</template>

<style>
.sg-list {
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
.sg-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.35rem 0.6rem;
  border-radius: var(--p-border-radius-md, 0.375rem);
  cursor: pointer;
}
.sg-item span { font-size: 0.8rem; color: var(--p-text-muted-color); text-align: right; }
.sg-item[data-active] { background: var(--p-highlight-background, rgb(0 0 0 / 0.06)); }
</style>
