<script lang="ts">
  // Confirmation for destructive actions (ui.confirm). Cancel is the default
  // button (TREE-08): it starts focused, and Enter activates the focused button,
  // so a stray or held Enter never deletes anything. Escape or a click outside cancels.
  import Modal from "./Modal.svelte";
  import { ui } from "../state/ui.svelte";
  import { t } from "../i18n";
  import { isComposing } from "../utils/platform";

  const dialog = $derived(ui.confirmDialog);
  let cancelButton: HTMLButtonElement | undefined = $state();
  let confirmButton: HTMLButtonElement | undefined = $state();

  const answer = (ok: boolean): void => ui.confirmDialog?.resolve(ok);

  function onKeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Auto-repeat of an Enter held down from the action that opened the dialog.
      if (!e.repeat) answer(e.currentTarget === confirmButton);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      (e.currentTarget === confirmButton ? cancelButton : confirmButton)?.focus();
    }
  }
</script>

{#if dialog}
  <!-- A replacing dialog remounts, so focus starts on Cancel again. -->
  {#key dialog}
    <Modal width={400} label={dialog.message} onclose={() => answer(false)}>
      <div class="confirm">
        <p class="message">{dialog.message}</p>
        <div class="actions">
          <button bind:this={cancelButton} type="button" class="text-btn" data-autofocus onkeydown={onKeydown} onclick={() => answer(false)}
            >{t("cancel")}</button
          >
          <button bind:this={confirmButton} type="button" class="text-btn primary" onkeydown={onKeydown} onclick={() => answer(true)}
            >{dialog.confirmLabel}</button
          >
        </div>
      </div>
    </Modal>
  {/key}
{/if}

<style>
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px;
  }

  .message {
    margin: 0;
    color: var(--c-text);
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
