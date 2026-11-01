// Types for kit.js, so TypeScript apps can import it directly.

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  mass?: number;
  /** Seconds, Apple style; use with bounce instead of stiffness and damping. */
  duration?: number;
  bounce?: number;
  /** Starting speed in distances per second. */
  velocity?: number;
  threshold?: number;
}
export interface ToastOptions {
  tone?: 'ok' | 'danger' | 'info';
  action?: { label: string; onClick?: () => void };
  /** The real error text, shown small in mono. */
  detail?: string;
  duration?: number;
}
export type Haptic = 'light' | 'select' | 'success' | 'warn' | 'danger' | 'long';

export function init(root?: ParentNode): void;
export function reducedMotion(): boolean;
export function announce(text: string, opts?: { assertive?: boolean }): void;
export function spring(opts?: SpringOptions): { easing: string; duration: number };
export const springs: Record<'sheet' | 'hero' | 'snappy', SpringOptions>;
export function animate(el: Element, keyframes: Keyframe[], options?: KeyframeAnimationOptions): Animation | null;
export function haptic(kind?: Haptic): void;
export function reveal(root?: ParentNode): void;
export function openSheet(el: HTMLDialogElement, opts?: { velocity?: number }): void;
export function closeSheet(el: HTMLDialogElement, opts?: { velocity?: number }): void;
export function openDialog(el: HTMLDialogElement): void;
export function closeDialog(el: HTMLDialogElement, returnValue?: string): void;
export function toast(message: string, opts?: ToastOptions): { dismiss: () => void; el: HTMLLIElement };
export function swipeRows(root?: ParentNode): void;
export function segmented(root?: ParentNode): void;
export function tabs(root?: ParentNode): void;
export function disabledWhy(root?: Document | Element): void;
/** 'phone' or 'desktop': the density kit.css uses for an element (the page by default). data-density wins, else coarse pointer or under 700px is phone. */
export function density(el?: Element): 'phone' | 'desktop';
/** Animate the height of every details.k-disclosure under root; native details keeps state and keyboard. */
export function disclosure(root?: ParentNode): void;
/** Clamp every .k-more text that overflows --k-more-lines, with a Show more button that expands it in place. */
export function more(root?: ParentNode): void;
export function countUp(
  el: Element,
  to: number,
  opts?: { from?: number; duration?: number; format?: (n: number) => string },
): Animation | void;
export function hero(el: Element, firstRect: DOMRect): Animation | null;
export function composer(el: Element, opts?: { onSend?: (text: string) => void }): void;
export function topbar(root?: ParentNode): void;
export function offline(root?: ParentNode): void;
declare const kit: {
  init: typeof init;
  toast: typeof toast;
  announce: typeof announce;
  haptic: typeof haptic;
  spring: typeof spring;
  animate: typeof animate;
  reveal: typeof reveal;
  openSheet: typeof openSheet;
  closeSheet: typeof closeSheet;
  openDialog: typeof openDialog;
  closeDialog: typeof closeDialog;
  swipeRows: typeof swipeRows;
  segmented: typeof segmented;
  tabs: typeof tabs;
  disclosure: typeof disclosure;
  more: typeof more;
  density: typeof density;
  countUp: typeof countUp;
  hero: typeof hero;
  composer: typeof composer;
  reducedMotion: typeof reducedMotion;
};
export default kit;
