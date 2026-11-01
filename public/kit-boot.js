// Loads the vendored ui-kit (public/kit) and hands it to the classic scripts as window.kit: toasts, springs and
// animate() come from here. A separate file because the page's CSP allows no inline script. If the kit fails to
// load, core.js falls back to its own toast and plain CSS motion, so Mint still opens.
import * as kit from '/kit/kit.js?v=__V__';
window.kit = kit;
// Not kit.init(): its document-wide busy guard would swallow every click inside an aria-busy container (the chat log is one while a
// turn streams), and Mint uses none of the data-k hooks it wires. toast, animate, spring and announce all work without it.
