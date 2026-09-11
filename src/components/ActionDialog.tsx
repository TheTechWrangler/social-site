import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface ActionDialogOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  intent?: 'destructive' | 'normal';
  confirmationText?: string;
}

/** Native modal dialogs provide top-layer background inertness and focus containment. */
export function ActionDialog({ title, description, confirmLabel = 'Confirm', intent = 'destructive',
  confirmationText, children, onConfirm, onClose, actionPending = false, actionError = '' }: ActionDialogOptions & {
  children?: ReactNode; onConfirm: () => Promise<unknown>; onClose: () => void;
  actionPending?: boolean; actionError?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const busy = pending || actionPending;
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => {
      mounted.current = false;
      dialog.current?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    if (busy) dialog.current?.focus();
    else cancel.current?.focus();
  }, [busy]);
  function close() { if (!locked.current && !busy) onClose(); }
  async function submit() {
    if (locked.current || busy || (confirmationText !== undefined && typed !== confirmationText)) return;
    locked.current = true;
    setPending(true); setError('');
    try {
      await onConfirm();
      if (mounted.current) onClose();
    } catch (failure: any) {
      if (mounted.current) setError(failure?.message || 'The action failed. Please try again.');
    } finally {
      locked.current = false;
      if (mounted.current) { setPending(false); cancel.current?.focus(); }
    }
  }
  return <dialog ref={dialog} tabIndex={-1} className="action-dialog" aria-modal="true" aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-description`} aria-busy={busy}
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      // No implicit destructive submission from a text field or the dialog itself.
      if (intent === 'destructive' && event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) event.preventDefault();
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || []);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <h2 id={`${id}-title`}>{title}</h2>
    <p id={`${id}-description`}>{description}</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      {children}
      {confirmationText !== undefined && <label>Type <strong>{confirmationText}</strong> to confirm
        <input className="input" value={typed} autoComplete="off" onChange={event => setTyped(event.target.value)} />
      </label>}
    </fieldset>
    {(actionError || error) && <p className="error-msg" role="alert">{actionError || error}</p>}
    {busy && <p role="status">Working…</p>}
    <div className="modal-actions">
      <button ref={cancel} type="button" className="btn btn-ghost" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className={`btn ${intent === 'destructive' ? 'btn-danger' : 'btn-primary'}`}
        disabled={busy || (confirmationText !== undefined && typed !== confirmationText)} onClick={() => void submit()}>{confirmLabel}</button>
    </div>
  </dialog>;
}

/** Capture the action at invocation; discard a dialog when its account/entity scope changes. */
export function useActionDialog(scope: string | number | undefined) {
  const [action, setAction] = useState<{ options: ActionDialogOptions; run: () => Promise<unknown>; scope: typeof scope } | null>(null);
  useEffect(() => { setAction(null); }, [scope]);
  return {
    confirmAction: (options: ActionDialogOptions, run: () => Promise<unknown>) => setAction(previous => previous || { options, run, scope }),
    actionDialog: action && action.scope === scope
      ? <ActionDialog {...action.options} onConfirm={action.run} onClose={() => setAction(null)} /> : null,
  };
}
