import { PageActionDispatchUncertainError } from './pageAct.js';

export interface PageDialogInfo {
  id: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt?: string;
  truncated?: true;
}

export class PageDialogInterruptedError extends Error {
  readonly code = 'DIALOG_PENDING';
  readonly dialog?: PageDialogInfo;
  readonly details: { dialog?: PageDialogInfo };

  constructor(dialog?: PageDialogInfo, readonly pageActionFailureStage: 'precondition' | 'dispatch-uncertain' = 'dispatch-uncertain') {
    super(dialog
      ? `DIALOG_PENDING: native ${dialog.type} dialog ${dialog.id}. Read it with page_snapshot, then use page_press with dialogId and Enter/Escape.`
      : 'DIALOG_PENDING: a previous page operation was interrupted; observe the page before continuing.');
    this.name = 'PageDialogInterruptedError';
    this.dialog = dialog;
    this.details = { ...(dialog ? { dialog } : {}) };
  }
}

/** Host-side state only: no page injection, implicit acceptance, or action replay. */
export class PageDialogState {
  private epoch = 0;
  private readonly prefix = crypto.randomUUID();
  private current?: PageDialogInfo;
  private defaultPromptTruncated = false;
  private readonly work = new Set<{ epoch: number }>();
  private readonly listeners = new Set<() => void>();
  private handling?: string;
  onIdle?: () => void;

  get pending(): boolean { return this.current !== undefined; }
  get busy(): boolean { return this.work.size > 0 || this.handling !== undefined; }

  info(maxChars = 240): PageDialogInfo | undefined {
    if (!this.current) return undefined;
    const limit = Number.isFinite(maxChars) ? Math.max(0, Math.min(maxChars, 100000)) : 240;
    const { message, defaultPrompt, ...rest } = this.current;
    return {
      ...rest,
      message: message.slice(0, limit),
      ...(defaultPrompt ? { defaultPrompt: defaultPrompt.slice(0, limit) } : {}),
      ...(message.length > limit || (defaultPrompt?.length ?? 0) > limit ? { truncated: true as const } : {}),
    };
  }

  opened(event: { type?: unknown; message?: unknown; defaultPrompt?: unknown }): void {
    if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(event.type))) return;
    this.defaultPromptTruncated = typeof event.defaultPrompt === 'string' && event.defaultPrompt.length > 65536;
    this.current = {
      id: `${this.prefix}:${++this.epoch}`,
      type: event.type as PageDialogInfo['type'],
      message: typeof event.message === 'string' ? event.message.slice(0, 65536) : '',
      ...(typeof event.defaultPrompt === 'string' && event.defaultPrompt
        ? { defaultPrompt: event.defaultPrompt.slice(0, 65536) } : {}),
      ...((typeof event.message === 'string' && event.message.length > 65536) ||
        (typeof event.defaultPrompt === 'string' && event.defaultPrompt.length > 65536) ? { truncated: true as const } : {}),
    };
    for (const listener of this.listeners) listener();
  }

  closed(): void {
    this.current = undefined;
    this.notifyIdle();
  }

  invalidate(): void {
    this.epoch += 1;
    this.current = undefined;
    for (const listener of this.listeners) listener();
    this.notifyIdle();
  }

  assertCanDispatch(): void {
    if (this.pending || [...this.work].some(entry => entry.epoch !== this.epoch)) {
      throw new PageDialogInterruptedError(this.info(), 'precondition');
    }
  }

  /** Register the actual handler, including its finally; never retain a raw browser Promise here. */
  execute<T>(work: () => Promise<T>, interrupt = true): Promise<T> {
    this.assertCanDispatch();
    const entry = { epoch: this.epoch };
    this.work.add(entry);
    let started = false;
    const release = () => {
      this.work.delete(entry);
      this.notifyIdle();
    };
    const start = () => {
      started = true;
      return Promise.resolve().then(() => {
        this.assertCanDispatch();
        return work();
      }).finally(release);
    };
    return (interrupt ? this.race(start) : start()).finally(() => {
      if (!started) release();
    });
  }

  /** Every real eval/input dispatch must pass here, so a late ack cannot resume its handler. */
  command<T>(work: () => Promise<T>): Promise<T> {
    this.assertCanDispatch();
    return this.race(work);
  }

  private race<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending) return Promise.reject(new PageDialogInterruptedError(this.info()));
    const epoch = this.epoch;
    return new Promise<T>((resolve, reject) => {
      const changed = () => {
        if (epoch === this.epoch) return;
        this.listeners.delete(changed);
        reject(new PageDialogInterruptedError(this.info()));
      };
      this.listeners.add(changed);
      let result: Promise<T>;
      try { result = work(); }
      catch (error) {
        this.listeners.delete(changed);
        reject(error);
        return;
      }
      Promise.resolve(result).then(value => {
        this.listeners.delete(changed);
        resolve(value);
      }, error => {
        this.listeners.delete(changed);
        reject(error);
      });
    });
  }

  async press(
    input: { dialogId?: string; key: string; promptText?: string; selector?: string; modifiers?: unknown[]; pressMode?: string },
    send: (params: { accept: boolean; promptText?: string }) => Promise<unknown>,
  ): Promise<{ pressed: true; key: string; dispatchMode: 'native-dialog' }> {
    const dialog = this.current;
    if (!input.dialogId || dialog?.id !== input.dialogId) throw new Error('page_press: dialogId is stale or no native dialog is open. Run page_snapshot.');
    if (this.handling) throw new Error('page_press: this native dialog is already being handled.');
    if (!['Enter', 'Escape'].includes(input.key) || input.selector !== undefined || input.modifiers?.length || (input.pressMode && input.pressMode !== 'auto')) {
      throw new Error('page_press: dialogId requires Enter/Escape without selector, modifiers, or an explicit pressMode.');
    }
    if (input.promptText !== undefined && (typeof input.promptText !== 'string' || dialog.type !== 'prompt' || input.key !== 'Enter')) {
      throw new Error('page_press: promptText is only valid when accepting a native prompt.');
    }
    const acceptsPrompt = dialog.type === 'prompt' && input.key === 'Enter';
    if (acceptsPrompt && input.promptText === undefined && this.defaultPromptTruncated) {
      throw new Error('page_press: the native prompt default was truncated. Specify promptText explicitly.');
    }
    this.handling = dialog.id;
    try {
      // No await between the last ID check and send. CDP itself has no atomic dialog-ID CAS.
      await send({ accept: input.key === 'Enter', ...(acceptsPrompt ? { promptText: input.promptText ?? dialog.defaultPrompt ?? '' } : {}) });
      return { pressed: true, key: input.key, dispatchMode: 'native-dialog' };
    } catch (error) {
      throw new PageActionDispatchUncertainError('page_press: native dialog handling was not acknowledged. Read page_snapshot before trying again.', { cause: error });
    } finally {
      this.handling = undefined;
      // Closed/Opening events own current state; an ack for A must not clear a new dialog B.
      this.notifyIdle();
    }
  }

  private notifyIdle(): void {
    if (!this.pending && !this.busy) this.onIdle?.();
  }
}

export function pageDialogSnapshot(dialogs: PageDialogState, mode = 'full', maxChars = 25000) {
  const dialog = dialogs.info(maxChars);
  return dialog ? {
    snapshot: `[native ${dialog.type} dialog]`,
    mode,
    elementCount: 0,
    outputNodeCount: 0,
    dialog,
  } : undefined;
}
