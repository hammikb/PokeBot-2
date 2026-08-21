# Retailer Controls and Product Preview Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Hide disabled retailer configuration fields while retaining their values, and enlarge product previews in the monitor/task UI.

**Architecture:** Keep retailer state in `MonitorBuilder` unchanged when toggled off. `RetailerSource` will always render the retailer header and switch, but will render its configuration controls only when `source.enabled` is true. Increase existing image utility classes in the monitor editor and task list without changing image URLs or data flow.

**Tech Stack:** React, Vite, Tailwind utility classes, Vitest.

## Global Constraints

- Disabled retailer values must remain in React state and restore when re-enabled.
- Form validation must continue to validate enabled retailers only.
- Do not alter persistence or monitor payload shapes.
- Preserve unrelated existing working-tree changes.

---

### Task 1: Add regression coverage for disabled retailer rendering

**Files:**
- Modify: `src/renderer/src/components/MonitorBuilder.jsx`
- Test: `tests/renderer/MonitorBuilder.test.jsx` (create if absent)

- [ ] **Step 1: Inspect the existing renderer test setup and component test conventions.**
- [ ] **Step 2: Add a test that renders a disabled retailer and asserts its URL/pricing controls are absent while the switch/header remains.**
- [ ] **Step 3: Run the focused test and confirm it fails before the conditional rendering change.**

### Task 2: Implement conditional retailer controls and larger previews

**Files:**
- Modify: `src/renderer/src/components/MonitorBuilder.jsx`
- Modify: `src/renderer/src/pages/Tasks.jsx` if its task-row preview uses the same thumbnail sizing shown in the request.

- [ ] **Step 1: Wrap the retailer URL, price/quantity/order grid, and account buttons in `source.enabled && (...)`; retain the header/switch and add a compact disabled-state label.**
- [ ] **Step 2: Increase the monitor editor product image from the current 24×24 utility size to a visibly larger size while preserving containment and responsive layout.**
- [ ] **Step 3: Increase the task-list thumbnail size only where the existing product preview is rendered, avoiding layout changes to controls.**
- [ ] **Step 4: Run the focused renderer tests and confirm they pass.**
- [ ] **Step 5: Run the renderer lint/build checks and verify no unrelated files changed.**
