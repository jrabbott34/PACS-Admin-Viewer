/**
 * A trigger button that "explodes" a panel open below it — used for the tool
 * picker, the layout picker and the main menu. Closes on an inside button
 * click, an outside click, or Escape.
 */
export interface Flyout {
  close(): void;
  readonly isOpen: boolean;
}

export function createFlyout(trigger: HTMLButtonElement, panel: HTMLElement): Flyout {
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  panel.classList.add('flyout-panel');
  panel.setAttribute('aria-hidden', 'true');

  const setOpen = (open: boolean): void => {
    if (open === panel.classList.contains('show')) return;
    panel.classList.toggle('show', open);
    panel.setAttribute('aria-hidden', String(!open));
    trigger.setAttribute('aria-expanded', String(open));
    trigger.classList.toggle('open', open);
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!panel.classList.contains('show'));
  });
  panel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (btn && !btn.disabled) setOpen(false);
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (panel.classList.contains('show') && !panel.contains(t) && !trigger.contains(t)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  return {
    close: () => setOpen(false),
    get isOpen() {
      return panel.classList.contains('show');
    },
  };
}
