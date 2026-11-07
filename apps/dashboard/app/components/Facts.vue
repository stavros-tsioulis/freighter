<!--
  A strip of labelled boxes, like the fields on a shipping label. Each box draws its right and bottom
  divider; the outer edge clips the ones that land on the border, so it wraps cleanly at any width.
-->
<template>
  <dl class="facts"><slot /></dl>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-lg);
  overflow: hidden;
  margin: 0;
}
</style>
